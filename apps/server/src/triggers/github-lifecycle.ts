import type { TriggerEvent, TriggerGithubRepository } from '@zero-os/shared'

type LifecycleKind = 'issue' | 'pr'
type LifecycleAction = 'opened' | 'closed' | 'reopened' | 'merged'
const labels = { opened: '新建', closed: '关闭', reopened: '重新打开', merged: '合并' } as const

interface ReadApi {
  page<T>(path: string): Promise<{ data: T | null; next: string | null }>
}
interface LifecycleItem {
  number: number
  title: string
  body?: string | null
  created_at: string
  closed_at: string | null
}
interface Issue extends LifecycleItem {
  repository_url: string
  pull_request?: unknown
}
interface Pull extends LifecycleItem {
  base: { repo: { id: number; full_name: string } }
  updated_at: string
  merged_at: string | null
}
interface IssueEvent {
  event: string
  created_at: string
}

function dateMs(time: string): number {
  const ms = Date.parse(time)
  if (!Number.isFinite(ms)) throw new Error('Invalid lifecycle timestamp in GitHub response')
  return ms
}

export function githubLifecycleEvent(
  repository: string,
  repositoryId: number,
  kind: LifecycleKind,
  number: number,
  action: LifecycleAction,
  time: string,
  title: string,
  body?: string | null,
): TriggerEvent {
  const ms = dateMs(time)
  const excerpt = body?.replace(/\s+/gu, ' ').trim().slice(0, 500)
  return {
    scope: repository,
    eventId: `${repositoryId}:${kind}:${number}:${action}:${ms}`,
    businessKey: `${kind}:${number}`,
    title: `${kind === 'pr' ? 'PR' : 'Issue'} #${number} · ${labels[action]}`,
    summary: [
      `${repository} · ${title.replace(/\s+/gu, ' ').trim().slice(0, 300)}`,
      excerpt && `采集时正文摘录：${excerpt}`,
    ]
      .filter(Boolean)
      .join('\n'),
    occurredAt: new Date(ms).toISOString(),
    url: `https://github.com/${repository}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
  }
}

async function* pages<T>(api: ReadApi, path: string, repositoryId: number) {
  const first = new URL(path, 'https://api.github.com')
  const canonical = first.pathname.replace(
    /^\/repos\/[^/]+\/[^/]+/,
    `/repositories/${repositoryId}`,
  )
  let next: string | null = path
  const seen = new Set<string>()
  while (next) {
    const url = new URL(next, first)
    if (
      url.origin !== first.origin ||
      ![first.pathname.toLowerCase(), canonical.toLowerCase()].includes(
        url.pathname.toLowerCase(),
      ) ||
      seen.has(url.href)
    )
      throw new Error('Invalid GitHub lifecycle pagination')
    seen.add(url.href)
    const page: { data: T[] | null; next: string | null } = await api.page<T[]>(next)
    if (!Array.isArray(page.data)) throw new Error('Missing GitHub lifecycle records')
    yield* page.data
    next = page.next
  }
}

// The issue list requires Issues read permission. Query pull requests independently so a
// PR-only grant does not need access to private issue data.
async function* changedObjects(
  api: ReadApi,
  repo: TriggerGithubRepository,
  path: string,
  repositoryId: number,
  since: number,
) {
  if (repo.issues) {
    // GitHub's `since` is exclusive and lifecycle timestamps have second precision.
    const from = new Date(since - 1000).toISOString()
    const query = `${path}/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(from)}&per_page=100`
    for await (const issue of pages<Issue>(api, query, repositoryId)) {
      if (issue.repository_url?.toLowerCase() !== `https://api.github.com${path}`.toLowerCase())
        throw new Error('Out-of-scope issue in GitHub response')
      if (!issue.pull_request) yield { item: issue, kind: 'issue' as const, mergedAt: null }
    }
  }
  if (repo.pullRequests) {
    const query = `${path}/pulls?state=all&sort=updated&direction=desc&per_page=100`
    for await (const pull of pages<Pull>(api, query, repositoryId)) {
      if (
        pull.base?.repo?.id !== repositoryId ||
        pull.base.repo.full_name.toLowerCase() !== repo.name.toLowerCase()
      )
        throw new Error('Out-of-scope pull request in GitHub response')
      if (dateMs(pull.updated_at) < since) break
      yield {
        item: pull,
        kind: 'pr' as const,
        mergedAt: pull.merged_at ? dateMs(pull.merged_at) : null,
      }
    }
  }
}

/** The current state alone cannot distinguish a close/reopen between polls. */
export async function scanGithubLifecycle(
  api: ReadApi,
  repo: TriggerGithubRepository,
  path: string,
  repositoryId: number,
  since: number,
) {
  const result = new Map<string, TriggerEvent>()
  for await (const { item, kind, mergedAt: snapshotMerge } of changedObjects(
    api,
    repo,
    path,
    repositoryId,
    since,
  )) {
    if (!Number.isSafeInteger(item.number) || item.number < 1 || typeof item.title !== 'string')
      throw new Error('Invalid issue or pull request in GitHub response')
    const record = (action: LifecycleAction, time: string) => {
      if (dateMs(time) < since) return
      const event = githubLifecycleEvent(
        repo.name,
        repositoryId,
        kind,
        item.number,
        action,
        time,
        item.title,
        item.body,
      )
      result.set(event.eventId, event)
    }
    record('opened', item.created_at)
    const transitions: { action: 'closed' | 'merged' | 'reopened'; time: string }[] = []
    let mergedAt = snapshotMerge
    for await (const event of pages<IssueEvent>(
      api,
      `${path}/issues/${item.number}/events?per_page=100`,
      repositoryId,
    )) {
      if (
        event.event !== 'closed' &&
        event.event !== 'reopened' &&
        !(event.event === 'merged' && kind === 'pr')
      )
        continue
      const ms = dateMs(event.created_at)
      if (ms < since) continue
      if (event.event === 'merged') mergedAt = ms
      transitions.push({ action: event.event, time: event.created_at })
    }
    // A merged PR generates both "merged" and "closed" issue events. Its final close
    // is reported only as a merge, matching the single GitHub webhook for that action.
    const finalClose = item.closed_at && dateMs(item.closed_at)
    for (const { action, time } of transitions) {
      if (
        action === 'closed' &&
        mergedAt !== null &&
        (dateMs(time) >= mergedAt || dateMs(time) === finalClose)
      )
        continue
      record(action, time)
    }
  }
  return [...result.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
}
