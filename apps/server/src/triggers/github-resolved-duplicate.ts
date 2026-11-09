import type { RouterEventWork, TriggerInboxItem, TriggerSettingsSnapshot } from '@zero-os/shared'
import type { GithubAppAuth } from './github-app-auth'
import { disputesDuplicate, findExactResolvedDuplicate } from './github-exact-duplicate'
import {
  type GithubIssueCloseGuard,
  GithubIssueCloseUncertainError,
  type createGithubIssueCloser,
} from './github-issue-close'
import { githubReplySubject } from './router-github-reply'
import { RouterJobExecutionUncertainError } from './router-jobs'

type Read = (url: URL, init: RequestInit) => Promise<Response>
type Row = Record<string, unknown>
const row = (x: unknown): x is Row => x !== null && typeof x === 'object' && !Array.isArray(x)
const number = (x: unknown): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x > 0
const same = (x: unknown, s: string) => typeof x === 'string' && x.toLowerCase() === s.toLowerCase()
const ms = (x: unknown) => (typeof x === 'string' ? Date.parse(x) : Number.NaN)
const marker = (text: unknown) =>
  typeof text === 'string' ? text.trim().match(/^Duplicate of #([1-9]\d*)\.?$/iu)?.[1] : undefined
const timelineQuery = `query ResolvedDuplicate($id:ID!){node(id:$id){... on Issue{
  id url state repository {id}
  timelineItems(last:100,itemTypes:[MARKED_AS_DUPLICATE_EVENT,UNMARKED_AS_DUPLICATE_EVENT,REOPENED_EVENT]){
    pageInfo {hasPreviousPage} nodes {__typename
      ... on MarkedAsDuplicateEvent {id createdAt isCrossRepository actor{login} duplicate{... on Issue{id}} canonical{... on Issue{id}} }
      ... on UnmarkedAsDuplicateEvent {isCrossRepository duplicate{... on Issue{id}} canonical{... on Issue{id}}}
    }
  }
  markerContext: timelineItems(last:2,itemTypes:[ISSUE_COMMENT,MARKED_AS_DUPLICATE_EVENT,UNMARKED_AS_DUPLICATE_EVENT,REOPENED_EVENT]){
    nodes{__typename ... on IssueComment{id} ... on MarkedAsDuplicateEvent{id}}
  }
}}}`

type Evidence = {
  id: number
  updatedAt: string
  canonical: number
  canonicalId: number
  source: string
  method: 'marker' | 'exact'
}

export function resolvedDuplicateCandidate(
  event: TriggerInboxItem,
  settings: TriggerSettingsSnapshot['settings'],
) {
  const repos = settings.github.repositories
  const subject = githubReplySubject(event, repos)
  if (!subject || subject.kind !== 'issue') return null
  const target = subject
  const repo = repos.find((r) => r.name === target.repository)
  const since = ms(repo?.closeResolvedDuplicatesSince)
  const occurred = ms(event.occurredAt)
  if (!repo?.enabled || !repo.issues || !repo.closeResolvedDuplicates || !(occurred > since))
    return null
  const opened =
    event.eventId === `${target.repositoryId}:issue:${target.number}:opened:${occurred}`
  const comment =
    event.githubCommentKind === 'issue-comment' &&
    repo.issueComments &&
    /:comment:([1-9]\d*)$/u.exec(event.eventId)?.[1]
  // A new marker is reconsidered only for the comment that created it, not an unrelated later discussion.
  if (!opened && (!comment || !marker(event.summary.slice(event.summary.indexOf('：') + 1))))
    return null
  return { target, since, occurred, opened, comment }
}

/** The only settings-derived authorization to close an Issue without an explicit close request. */
export function createDuplicateEvidenceReader(
  settings: () => TriggerSettingsSnapshot,
  auth: GithubAppAuth,
  fetcher: Read = fetch,
) {
  return async (event: TriggerInboxItem, signal: AbortSignal, current: () => boolean) => {
    const snapshot = settings()
    const revision = snapshot.revision
    const candidate = resolvedDuplicateCandidate(event, snapshot.settings)
    if (!candidate || !current()) return null
    const { target, since, occurred, opened, comment } = candidate
    const active = () => current() && !signal.aborted && settings().revision === revision
    async function investigate(abort: AbortSignal): Promise<Evidence | null> {
      if (!active()) return null
      const stop = AbortSignal.any([abort, signal, AbortSignal.timeout(45_000)])
      const token = await auth.getToken(target.ref, target.repository, stop)
      const base = `https://api.github.com/repos/${target.repository}`
      const getJson = async (url: URL, body?: object) => {
        if (!active()) return null
        const r = await fetcher(url, {
          method: body ? 'POST' : 'GET',
          body: body ? JSON.stringify(body) : undefined,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'ZeRo-Duplicate-Investigation',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          redirect: 'manual',
          credentials: 'omit',
          signal: stop,
        })
        if (r.status === 404 || r.status === 410) {
          await r.body?.cancel()
          return null
        }
        if (!r.ok) {
          await r.body?.cancel()
          throw new Error(`无法核实重复 Issue 的证据（GitHub HTTP ${r.status}）。`)
        }
        return r.json() as Promise<unknown>
      }
      const get = (path: string) => getJson(new URL(base + path))
      const [info, issue] = await Promise.all([get(''), get(`/issues/${target.number}`)])
      if (
        !row(info) ||
        info.id !== target.repositoryId ||
        !same(info.full_name, target.repository) ||
        typeof info.node_id !== 'string' ||
        !row(issue) ||
        issue.number !== target.number ||
        !number(issue.id) ||
        issue.pull_request != null ||
        issue.state !== 'open' ||
        typeof issue.node_id !== 'string' ||
        !same(issue.repository_url, base) ||
        !same(issue.html_url, target.url) ||
        typeof issue.updated_at !== 'string' ||
        ms(issue.updated_at) !== occurred
      )
        return null
      let canonical: { number: number; id: number; url: string } | null = null
      let canonicalNodeId: string | undefined
      let markerCommentNodeId: string | undefined
      const method = opened ? 'exact' : 'marker'
      if (opened) {
        if (ms(issue.created_at) !== occurred) return null
        canonical = await findExactResolvedDuplicate({
          repository: target.repository,
          current: issue,
          get,
          search: (q) => {
            const u = new URL('https://api.github.com/search/issues')
            u.search = new URLSearchParams({ q, per_page: '100' }).toString()
            return getJson(u)
          },
        })
        if (!canonical) return null
      } else {
        if (
          !number(issue.comments) ||
          issue.comments > 100 ||
          typeof issue.title !== 'string' ||
          (issue.body !== null && typeof issue.body !== 'string') ||
          disputesDuplicate(`${issue.title}\n${issue.body ?? ''}`) ||
          !row(info.owner) ||
          info.owner.type !== 'User' ||
          !number(info.owner.id) ||
          typeof info.owner.login !== 'string'
        )
          return null
        // Require the entire discussion. A superseded marker, unresolved disagreement, or partial read is not evidence.
        const discussion = await get(`/issues/${target.number}/comments?per_page=100`)
        if (
          !Array.isArray(discussion) ||
          discussion.length !== issue.comments ||
          discussion.some(
            (c) =>
              !row(c) ||
              !same(c.issue_url, `${base}/issues/${target.number}`) ||
              typeof c.body !== 'string' ||
              disputesDuplicate(c.body),
          )
        )
          return null
        const c = discussion.at(-1)
        if (
          !row(c) ||
          c.id !== Number(comment) ||
          !same(c.issue_url, `${base}/issues/${target.number}`) ||
          !same(c.html_url, event.url ?? '') ||
          !row(c.user) ||
          c.user.id !== info.owner.id ||
          c.user.type !== 'User' ||
          c.user.login !== info.owner.login ||
          c.author_association !== 'OWNER' ||
          ms(c.created_at) !== occurred ||
          c.created_at !== c.updated_at
        )
          return null
        if (typeof c.node_id === 'string') markerCommentNodeId = c.node_id
        const n = Number(marker(c.body))
        if (!number(n) || n >= target.number) return null
        const hist = await get(`/issues/${n}`)
        const source = `https://github.com/${target.repository}/issues/${n}`
        if (
          !row(hist) ||
          hist.number !== n ||
          !number(hist.id) ||
          typeof hist.node_id !== 'string' ||
          hist.id === issue.id ||
          hist.pull_request != null ||
          hist.state !== 'closed' ||
          hist.state_reason !== 'completed' ||
          !same(hist.repository_url, base) ||
          !same(hist.html_url, source) ||
          !(ms(hist.created_at) < ms(issue.created_at) && ms(hist.closed_at) <= occurred)
        )
          return null
        canonical = { number: n, id: hist.id, url: source }
        canonicalNodeId = hist.node_id
      }
      const timeline = await getJson(new URL('https://api.github.com/graphql'), {
        query: timelineQuery,
        variables: { id: issue.node_id },
      })
      if (!row(timeline) || timeline.errors || !row(timeline.data) || !row(timeline.data.node))
        return null
      const node = timeline.data.node
      if (
        node.id !== issue.node_id ||
        !same(node.url, target.url) ||
        node.state !== 'OPEN' ||
        !row(node.repository) ||
        node.repository.id !== info.node_id ||
        !row(node.timelineItems) ||
        !row(node.timelineItems.pageInfo) ||
        node.timelineItems.pageInfo.hasPreviousPage !== false ||
        !Array.isArray(node.timelineItems.nodes)
      )
        return null
      const items = node.timelineItems.nodes
      // Multiple marks/unmarks, an explicit reopening, or conflicting canonical targets need a person.
      if (opened) {
        if (items.length !== 0) return null
      } else {
        const mark = items.length === 1 ? items[0] : null
        if (
          !row(mark) ||
          mark.__typename !== 'MarkedAsDuplicateEvent' ||
          mark.isCrossRepository !== false ||
          !row(mark.duplicate) ||
          !row(mark.canonical) ||
          !row(mark.actor) ||
          !row(info.owner) ||
          mark.actor.login !== info.owner.login ||
          !(ms(mark.createdAt) >= occurred && ms(mark.createdAt) > since)
        )
          return null
        if (mark.duplicate.id !== issue.node_id || mark.canonical.id !== canonicalNodeId) {
          // GitHub can return the endpoints in the opposite order on the issue where
          // the owner posted the marker. Tie that event to the exact comment on this
          // timeline before using the comment to determine which issue to close.
          const pair = row(node.markerContext) && node.markerContext.nodes
          if (
            mark.canonical.id !== issue.node_id ||
            mark.duplicate.id !== canonicalNodeId ||
            ms(mark.createdAt) !== occurred ||
            !markerCommentNodeId ||
            typeof mark.id !== 'string' ||
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            !row(pair[0]) ||
            pair[0].__typename !== 'IssueComment' ||
            pair[0].id !== markerCommentNodeId ||
            !row(pair[1]) ||
            pair[1].__typename !== 'MarkedAsDuplicateEvent' ||
            pair[1].id !== mark.id
          )
            return null
        }
      }
      return active()
        ? {
            id: issue.id,
            updatedAt: issue.updated_at,
            canonical: canonical.number,
            canonicalId: canonical.id,
            source: canonical.url,
            method,
          }
        : null
    }
    const proof = await investigate(signal)
    if (!proof) return null
    const guard: GithubIssueCloseGuard = {
      current: active,
      expectedIssueId: proof.id,
      expectedUpdatedAt: proof.updatedAt,
      duplicateOf: { number: proof.canonical, id: proof.canonicalId },
      async verify(s) {
        const fresh = await investigate(s)
        return (
          fresh !== null &&
          fresh.id === proof.id &&
          fresh.updatedAt === proof.updatedAt &&
          fresh.canonicalId === proof.canonicalId &&
          fresh.method === proof.method
        )
      },
    }
    return { target, proof, guard }
  }
}

export function createResolvedDuplicatePolicy(
  settings: () => TriggerSettingsSnapshot,
  auth: GithubAppAuth,
  close: ReturnType<typeof createGithubIssueCloser>,
  fetcher: Read = fetch,
) {
  const readEvidence = createDuplicateEvidenceReader(settings, auth, fetcher)
  return async (
    event: TriggerInboxItem,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<{ result: string; work: RouterEventWork } | null> => {
    const evidence = await readEvidence(event, signal, current)
    if (!evidence) return null
    const { target, proof, guard } = evidence
    try {
      const result = await close(event, signal, guard)
      const reason =
        proof.method === 'exact'
          ? '同一报告者的完整故障报告与唯一已解决的原报告相同'
          : 'GitHub 仍保留仓库所有者建立的重复标记，原 Issue 已解决'
      return {
        result: `Issue #${target.number}${result.state === 'already_closed' ? ' 已处于关闭状态' : ' 已由 Worker 关闭'}。${reason}（#${proof.canonical}）。`,
        work: {
          outcome: 'resolved',
          steps: [{ tool: 'close_issue', ok: true }],
          publicFacts: [{ label: '当前状态', value: '已关闭' }],
          sources: [
            { label: '当前 Issue', url: target.url },
            { label: `已解决的重复项 #${proof.canonical}`, url: proof.source },
          ],
        },
      }
    } catch (error) {
      if (error instanceof GithubIssueCloseUncertainError)
        throw new RouterJobExecutionUncertainError(error.message)
      throw error
    }
  }
}
