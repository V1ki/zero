import type {
  RouterOpenPullRequestsPage,
  TriggerEvent,
  TriggerIgnoredDiscussion,
  TriggerGithubPermissionReport,
  TriggerGithubPermissionSelection,
  TriggerGithubRepository,
  TriggerRepositoryOption,
} from '@zero-os/shared'
import type { GithubAppAuth } from './github-app-auth'
import { isUnsafeGithubComment } from './github-comment-safety'
import { githubLifecycleEvent, scanGithubLifecycle } from './github-lifecycle'
import { failedJobFacts } from './investigation'

const API = 'https://api.github.com'
const OVERLAP_MS = 5 * 60_000
type Fetch = (url: URL, init: RequestInit) => Promise<Response>

export class GithubTriggerError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`GitHub HTTP ${status}${retryAfterMs ? ' (rate limited)' : ''}`)
  }
}

function retryDelay(response: Response): number | undefined {
  if (response.status !== 403 && response.status !== 429) return
  const after = response.headers.get('retry-after')
  if (after) {
    const ms = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()
    if (Number.isFinite(ms)) return Math.max(1000, ms)
  }
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
    return reset > 0 ? Math.max(1000, reset - Date.now()) : 60_000
  }
  if (response.status === 429) return 60_000
}

function safeUrl(path: string): URL {
  const url = new URL(path, API)
  if (url.origin !== API || url.username || url.password) throw new Error('Unsafe GitHub API URL')
  return url
}

function repoPath(name: string): string {
  const parts = name.split('/')
  if (
    parts.length !== 2 ||
    !/^[a-z\d-]+$/i.test(parts[0]) ||
    !/^[a-z\d_.-]+$/i.test(parts[1]) ||
    parts[1] === '.' ||
    parts[1] === '..'
  )
    throw new Error('Expected a GitHub owner/repository name')
  return `/repos/${name}`
}

function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('Invalid ID in GitHub response')
  return value
}

function timestamp(value: string): number {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error('Invalid GitHub timestamp')
  return ms
}

interface Page<T> {
  data: T | null
  next: string | null
  etag?: string
}

function githubHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ZeRo-OS-Trigger',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

class GithubApi {
  constructor(
    private token: string | undefined,
    readonly signal: AbortSignal,
    private fetcher: Fetch,
  ) {}

  async page<T>(path: string, etag?: string): Promise<Page<T>> {
    let url = safeUrl(path)
    const headers = githubHeaders(this.token)
    if (etag) headers['If-None-Match'] = etag
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await this.fetcher(url, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(25_000)]),
      })
      if (response.status === 304 && etag) return { data: null, next: null, etag }
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) throw new Error('GitHub redirect missing Location')
        url = safeUrl(new URL(location, url).href)
        continue
      }
      if (!response.ok) {
        let delay = retryDelay(response)
        if (response.status === 403 && !delay && /rate limit/i.test(await response.text())) {
          delay = 60_000
        }
        throw new GithubTriggerError(response.status, delay)
      }
      const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1]
      return {
        data: (await response.json()) as T,
        next: next ? safeUrl(next).href : null,
        etag: response.headers.get('etag') ?? undefined,
      }
    }
    throw new Error('Too many GitHub redirects')
  }
}

interface Repository {
  id: number
  full_name: string
}
interface Run {
  id: number
  run_attempt?: number
  repository?: { id: number }
  name: string | null
  path: string
  head_branch: string | null
  status: string
  conclusion: string | null
  created_at: string
  updated_at: string
}
interface Comment {
  id: number
  body: string
  created_at: string
  updated_at?: string
  html_url: string
  user: { login: string; type?: string } | null
}

interface Cursor {
  repositoryId: number
  scannedAt: string
  pending: number[]
  runsEtag?: string
  comments?: { path: string; etag: string; rules?: string }
}

async function repositoryNamesPage(api: GithubApi, path: string) {
  const result = await api.page<Repository[]>(path)
  if (!Array.isArray(result.data)) throw new Error('Invalid GitHub repository list')
  const names = result.data.map((repo) => {
    repoPath(repo.full_name)
    return repo.full_name
  })
  return { names, next: result.next }
}

/** The Router reads one bounded page per call. The host fixes the endpoint and credentials. */
export async function listGithubRepositoryPage(
  token: string,
  page: number,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
) {
  const path = `/user/repos?per_page=20&sort=full_name&direction=asc&page=${page}`
  const { names, next } = await repositoryNamesPage(new GithubApi(token, signal, fetcher), path)
  if (names.length > 20) throw new Error('GitHub repository page exceeded the requested size')
  return { page, repositories: names, nextPage: next ? page + 1 : null }
}

export async function listGithubRepositories(
  token: string | undefined,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
): Promise<TriggerRepositoryOption[]> {
  if (!token) return []
  const api = new GithubApi(token, signal, fetcher)
  let path: string | null = '/user/repos?per_page=100&sort=full_name&direction=asc'
  const names = new Set<string>()
  while (path) {
    const page = await repositoryNamesPage(api, path)
    for (const name of page.names) names.add(name)
    path = page.next
  }
  return Array.from(names, (name) => ({ name }))
}

async function repositoryAt(api: GithubApi, path: string) {
  const { data } = await api.page<Repository>(path)
  if (!data) throw new Error('Missing GitHub repository')
  id(data.id)
  repoPath(data.full_name)
  return data
}

export async function getGithubRepository(
  name: string,
  token: string | undefined,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
): Promise<TriggerRepositoryOption> {
  const repo = await repositoryAt(new GithubApi(token, signal, fetcher), repoPath(name))
  return { name: repo.full_name }
}

/** Read one page from the operator's connection. Use the base repository for forks as well. */
export async function listGithubOpenPullRequests(
  repository: string,
  token: string,
  signal: AbortSignal,
  fetcher: Fetch,
  page: number,
  pageSize: 5 | 10,
): Promise<RouterOpenPullRequestsPage> {
  const repo = await repositoryAt(new GithubApi(token, signal, fetcher), repoPath(repository))
  if (repo.full_name.toLowerCase() !== repository.toLowerCase())
    throw new Error('GitHub repository name changed')
  const path = `${repoPath(repo.full_name)}/pulls`
  // A renamed repository can redirect within api.github.com. Do not read an unrelated destination.
  const api = new GithubApi(token, signal, (url, init) => {
    if (url.pathname !== path && url.pathname !== `/repositories/${repo.id}/pulls`)
      throw new Error('GitHub pull request list moved to another repository')
    return fetcher(url, init)
  })
  const result = await api.page<
    {
      number: number
      title: string
      state: string
      draft?: boolean
      html_url: string
      base: { repo: Repository }
    }[]
  >(`${path}?state=open&per_page=${pageSize}&sort=created&direction=desc&page=${page}`)
  if (!Array.isArray(result.data) || result.data.length > pageSize)
    throw new Error('Invalid GitHub pull request list')
  const pullRequests = result.data.map((pull) => {
    const number = id(pull.number)
    const url = `https://github.com/${repo.full_name}/pull/${number}`
    if (
      pull.state !== 'open' ||
      pull.base?.repo?.id !== repo.id ||
      pull.html_url?.toLowerCase() !== url.toLowerCase() ||
      typeof pull.title !== 'string' ||
      !pull.title.trim() ||
      (pull.draft !== undefined && typeof pull.draft !== 'boolean')
    )
      throw new Error('Invalid GitHub pull request record')
    const title = pull.title.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ').trim()
    return { number, title, url, draft: pull.draft === true }
  })
  return {
    repository: repo.full_name,
    page,
    pageSize,
    pullRequests,
    nextPage: result.next ? page + 1 : null,
  }
}

type PermissionCheck = TriggerGithubPermissionReport['checks'][number]

export async function checkGithubReadPermissions(
  name: string,
  token: string | undefined,
  selection: TriggerGithubPermissionSelection,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
): Promise<TriggerGithubPermissionReport> {
  const path = repoPath(name)
  const resources: [PermissionCheck['resource'], string][] = []
  if (selection.workflowFailures) resources.push(['actions', 'actions/runs'])
  if (selection.prComments) resources.push(['prComments', 'issues/comments'])
  if (selection.issueComments) resources.push(['issueComments', 'issues/comments'])
  if (selection.pullRequestComments) resources.push(['pullRequestComments', 'issues/comments'])
  if (selection.prBase) resources.push(['prBase', 'pulls'])
  if (selection.issues) resources.push(['issues', 'issues'])
  if (selection.pullRequests) resources.push(['pullRequests', 'pulls'])
  const headers = githubHeaders(token)

  async function probe([resource, suffix]: (typeof resources)[number]): Promise<PermissionCheck> {
    const url = safeUrl(`${path}/${suffix}?per_page=1`)
    const init = {
      headers,
      redirect: 'manual' as const,
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    }
    try {
      let response = await fetcher(url, { ...init, method: 'HEAD' })
      await response.body?.cancel()
      if (response.status === 405 || response.status === 501) {
        response = await fetcher(url, { ...init, method: 'GET' })
        await response.body?.cancel()
      }
      if (response.ok) return { resource, status: 'readable' }
      const retryAfterMs = retryDelay(response)
      if (retryAfterMs) return { resource, status: 'rate_limited', retryAfterMs }
      if (response.status === 401 || response.status === 403) return { resource, status: 'denied' }
      if (response.status === 404) return { resource, status: 'not_found' }
      return { resource, status: 'unavailable' }
    } catch {
      signal.throwIfAborted()
      return { resource, status: 'unavailable' }
    }
  }
  const requests = new Map<string, Promise<PermissionCheck>>()
  return {
    access: token ? 'credential' : 'anonymous',
    checks: await Promise.all(
      resources.map(async ([resource, path]) => {
        const result = requests.get(path) ?? probe([resource, path])
        requests.set(path, result)
        return { ...(await result), resource }
      }),
    ),
  }
}

type FailureRun = Pick<Run, 'id' | 'run_attempt' | 'name' | 'path' | 'head_branch' | 'updated_at'>

function matchesWorkflow(repo: TriggerGithubRepository, run: FailureRun) {
  return (
    (!repo.branch || repo.branch === run.head_branch) &&
    (!repo.workflow || repo.workflow === run.name || repo.workflow === run.path)
  )
}

function workflowFailure(
  repo: TriggerGithubRepository,
  repositoryId: number,
  run: FailureRun,
): TriggerEvent {
  const attempt = id(run.run_attempt ?? 1)
  return {
    eventId: `${repositoryId}:run:${run.id}:${attempt}:failure`,
    scope: repo.name,
    occurredAt: run.updated_at,
    title: `${run.name ?? run.path} 工作流失败`,
    summary: `${repo.name} · ${run.head_branch ?? '无分支'} · 第 ${attempt} 次运行`,
    url: `https://github.com/${repo.name}/actions/runs/${run.id}/attempts/${attempt}`,
  }
}

async function scanRuns(
  api: GithubApi,
  repo: TriggerGithubRepository,
  path: string,
  cursor: Cursor,
  since: number,
  events: TriggerEvent[],
) {
  const pending = new Set(cursor.pending)
  const unseen = new Set(pending)
  const seenEvents = new Set<string>()
  function observe(run: Run) {
    id(run.id)
    // The name in the polling URL may have been transferred or reused since the last cursor.
    if (run.repository?.id !== cursor.repositoryId)
      throw new Error('GitHub repository identity changed; reconfigure this subscription')
    unseen.delete(run.id)
    if (!matchesWorkflow(repo, run)) return
    if (run.status !== 'completed') {
      if (pending.has(run.id) || timestamp(run.updated_at) >= since) pending.add(run.id)
      return
    }
    const wasPending = pending.delete(run.id)
    if (run.conclusion !== 'failure' || (!wasPending && timestamp(run.updated_at) < since)) return
    const event = workflowFailure(repo, cursor.repositoryId, run)
    if (seenEvents.has(event.eventId)) return
    seenEvents.add(event.eventId)
    events.push(event)
  }

  const allRuns = `${path}/actions/runs?per_page=100`
  let filtered = Boolean(repo.branch)
  let next: string | null = filtered
    ? `${allRuns}&branch=${encodeURIComponent(repo.branch)}`
    : allRuns
  let first = true
  let count = 0
  while (next) {
    const page: Page<{ workflow_runs: Run[] }> = await api.page(
      next,
      first ? cursor.runsEtag : undefined,
    )
    if (first) cursor.runsEtag = page.etag
    if (!page.data) break
    const runs = page.data.workflow_runs
    for (const run of runs) observe(run)
    count += runs.length
    const more = runs.length > 0 && timestamp(runs[runs.length - 1].created_at) >= since
    next = more ? page.next : null
    // Filtered searches expose at most 1,000 results. Fall back only if we
    // actually reach that boundary before covering this watch interval.
    if (more && filtered && count >= 1000) {
      filtered = false
      next = allRuns
    }
    first = false
  }
  for (const runId of unseen) {
    try {
      const { data } = await api.page<Run>(`${path}/actions/runs/${id(runId)}`)
      if (data) observe(data)
    } catch (error) {
      if (!(error instanceof GithubTriggerError) || ![404, 410].includes(error.status)) throw error
      pending.delete(runId) // A deleted run can no longer change to a failed state.
    }
  }
  cursor.pending = [...pending]
}

function mentionPattern(login: string) {
  if (!/^[a-z\d-]+(?:\[bot\])?$/i.test(login)) throw new Error('Invalid GitHub mention')
  return new RegExp(
    `(?:^|[^a-z0-9_@./-])@${login.replace(/[\[\]]/g, '\\$&')}(?![a-z0-9_-]|\\[bot\\])`,
    'i',
  )
}

type CommentKind = 'issue' | 'pr'

/** Derive both transports' selection and durable identity from the same newly-created discussion comment. */
function createCommentMatcher(
  repo: TriggerGithubRepository,
  repositoryId: number,
  readBase: (number: number) => Promise<string>,
  signal: AbortSignal,
  readIdentity: GithubAppAuth['getCommentIdentity'],
  ignored: TriggerIgnoredDiscussion[],
) {
  const login = repo.mention.replace(/^@/, '')
  const mention = login ? mentionPattern(login) : null
  const bases = new Map<number, string>()
  let botIdentity: Promise<string> | undefined
  return async (
    kind: CommentKind,
    number: number,
    comment: Omit<Comment, 'html_url'>,
    allowMention = true,
  ): Promise<TriggerEvent | undefined> => {
    const ordinary = kind === 'issue' ? repo.issueComments : repo.pullRequestComments
    let mentioned = kind === 'pr' && allowMention && !!mention?.test(comment.body)
    if (mentioned && repo.branch) {
      if (!bases.has(number)) bases.set(number, await readBase(number))
      mentioned = bases.get(number) === repo.branch
    }
    if (!ordinary && !mentioned) return
    const commentId = id(comment.id)
    const reference = {
      eventId: `${repositoryId}:comment:${commentId}`,
      url: `https://github.com/${repo.name}/${kind === 'issue' ? 'issues' : 'pull'}/${number}#issuecomment-${commentId}`,
      occurredAt: new Date(timestamp(comment.created_at)).toISOString(),
    }
    if (isUnsafeGithubComment(comment.body)) {
      ignored.push({
        ...reference,
        kind: kind === 'issue' ? 'issue-comment' : 'pr-comment',
        mentioned,
        reason: '评论命中危险操作或敏感凭据过滤规则。',
      })
      return
    }
    let ownComment = false
    if (repo.githubAppRef && comment.user?.type === 'Bot') {
      if (!readIdentity) throw new Error('无法核验已绑定 GitHub App 的机器人身份。')
      botIdentity ??= readIdentity(repo.githubAppRef, repo.name, signal)
      ownComment = (await botIdentity).toLowerCase() === comment.user.login.toLowerCase()
    }
    return {
      ...reference,
      scope: repo.name,
      title: `${kind === 'issue' ? 'Issue' : 'PR'} #${number} · ${mentioned ? `@${login}` : '新评论'}`,
      summary: `${comment.user?.login ?? '未知作者'}：${comment.body.slice(0, 300)}`,
      ...(ownComment && { githubOwnComment: true as const }),
      ...(ordinary && {
        githubCommentKind: kind === 'issue' ? ('issue-comment' as const) : ('pr-comment' as const),
        ...(mentioned && { githubCommentMention: true as const }),
      }),
    }
  }
}

function commentTarget(repo: TriggerGithubRepository, comment: Pick<Comment, 'id' | 'html_url'>) {
  if (!URL.canParse(comment.html_url)) return
  const url = new URL(comment.html_url)
  const parts = url.pathname.split('/')
  const [, owner, name, family, number] = parts
  if (
    url.origin !== 'https://github.com' ||
    url.username ||
    url.password ||
    parts.length !== 5 ||
    `${owner}/${name}`.toLowerCase() !== repo.name.toLowerCase() ||
    (family !== 'pull' && family !== 'issues') ||
    !/^[1-9]\d*$/.test(number) ||
    url.hash !== `#issuecomment-${id(comment.id)}`
  )
    return
  return {
    kind: family === 'pull' ? ('pr' as const) : ('issue' as const),
    number: id(Number(number)),
  }
}

async function prBase(api: GithubApi, path: string, number: number, repositoryId: number) {
  const { data } = await api.page<{ base: { ref: string; repo?: { id: number } } }>(
    `${path}/pulls/${number}`,
  )
  if (!data?.base?.ref) throw new Error('Missing GitHub pull request branch')
  if (data.base.repo && data.base.repo.id !== repositoryId) {
    throw new Error('GitHub repository identity changed; reconfigure this subscription')
  }
  return data.base.ref
}

async function scanComments(
  api: GithubApi,
  repo: TriggerGithubRepository,
  path: string,
  cursor: Cursor,
  mentionSince: number,
  ordinarySince: number,
  events: TriggerEvent[],
  readIdentity: GithubAppAuth['getCommentIdentity'],
  ignored: TriggerIgnoredDiscussion[],
) {
  const match = createCommentMatcher(
    repo,
    cursor.repositoryId,
    (number) => prBase(api, path, number, cursor.repositoryId),
    api.signal,
    readIdentity,
    ignored,
  )
  const ordinary = repo.issueComments || repo.pullRequestComments
  const since = ordinary ? ordinarySince : mentionSince
  // GitHub's update cutoff is exclusive. Include the activation second of a new comment watch.
  const from = new Date(
    Math.floor((ordinary ? since - 1000 : since) / 60_000) * 60_000,
  ).toISOString()
  const firstPath = `${path}/issues/comments?per_page=100&sort=updated&direction=asc&since=${encodeURIComponent(from)}`
  const rules = JSON.stringify([
    !!repo.issueComments,
    !!repo.pullRequestComments,
    repo.mention,
    repo.branch,
  ])
  const filter =
    cursor.comments?.path === firstPath && cursor.comments.rules === rules
      ? cursor.comments.etag
      : undefined
  let next: string | null = firstPath
  const visited = new Set<string>()
  while (next) {
    const url = safeUrl(next)
    if (
      ![
        `${path}/issues/comments`.toLowerCase(),
        `/repositories/${cursor.repositoryId}/issues/comments`,
      ].includes(url.pathname.toLowerCase()) ||
      visited.has(url.href)
    )
      throw new Error('Invalid GitHub comment pagination')
    visited.add(url.href)
    const page: Page<Comment[]> = await api.page(next, next === firstPath ? filter : undefined)
    if (!page.data) return
    if (next === firstPath) {
      cursor.comments =
        !page.next && page.etag ? { path: firstPath, etag: page.etag, rules } : undefined
    }
    for (const comment of page.data) {
      const created = timestamp(comment.created_at)
      if (created < since) continue
      // The REST snapshot cannot recover the original body after an edit. Never emit
      // an edited message as a new comment, including one previously rejected for safety.
      if (comment.updated_at && timestamp(comment.updated_at) > created) continue
      const target = commentTarget(repo, comment)
      if (!target) continue
      const event = await match(target.kind, target.number, comment, created >= mentionSince)
      if (event) events.push(event)
    }
    next = page.next
  }
}

export class GithubWebhookPayloadError extends Error {
  constructor() {
    super('Invalid or out-of-scope GitHub webhook payload')
  }
}

function payloadObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GithubWebhookPayloadError()
  return value as Record<string, unknown>
}

function payloadText(value: unknown): string {
  if (typeof value !== 'string') throw new GithubWebhookPayloadError()
  return value
}

function payloadId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new GithubWebhookPayloadError()
  return value
}

function payloadTime(value: unknown): string {
  const time = payloadText(value)
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(time) ||
    !Number.isFinite(Date.parse(time))
  )
    throw new GithubWebhookPayloadError()
  return time
}

function lifecycleWebhook(
  repo: TriggerGithubRepository,
  repositoryId: number,
  kind: 'issue' | 'pr',
  body: Record<string, unknown>,
): TriggerEvent[] {
  const action = payloadText(body.action)
  if (action !== 'opened' && action !== 'reopened' && action !== 'closed') return []
  const item = payloadObject(kind === 'pr' ? body.pull_request : body.issue)
  const number = payloadId(item.number)
  if (kind === 'pr') {
    const base = payloadObject(payloadObject(item.base).repo)
    if (
      payloadId(body.number) !== number ||
      payloadId(base.id) !== repositoryId ||
      (base.full_name !== undefined &&
        payloadText(base.full_name).toLowerCase() !== repo.name.toLowerCase())
    )
      throw new GithubWebhookPayloadError()
    if (
      action === 'closed' &&
      item.merged !== undefined &&
      item.merged !== (item.merged_at != null)
    )
      throw new GithubWebhookPayloadError()
  } else {
    if (item.pull_request != null) throw new GithubWebhookPayloadError()
    if (
      item.repository_url !== undefined &&
      payloadText(item.repository_url).toLowerCase() !== `${API}/repos/${repo.name.toLowerCase()}`
    )
      throw new GithubWebhookPayloadError()
  }
  const change = kind === 'pr' && action === 'closed' && item.merged_at != null ? 'merged' : action
  const timeField = {
    opened: 'created_at',
    closed: 'closed_at',
    merged: 'merged_at',
    reopened: 'updated_at',
  } as const
  return [
    githubLifecycleEvent(
      repo.name,
      repositoryId,
      kind,
      number,
      change,
      payloadTime(item[timeField[change]]),
      payloadText(item.title),
      item.body == null ? undefined : payloadText(item.body),
    ),
  ]
}

/** The HTTP receiver authenticates the original bytes before handing off the JSON here. */
export async function normalizeGithubWebhook(
  repo: TriggerGithubRepository,
  event: string,
  payload: unknown,
  getToken: () => string | undefined | Promise<string | undefined>,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
  readIdentity?: GithubAppAuth['getCommentIdentity'],
  ignored: TriggerIgnoredDiscussion[] = [],
): Promise<TriggerEvent[]> {
  const body = payloadObject(payload)
  const repository = payloadObject(body.repository)
  const repositoryId = payloadId(repository.id)
  if (payloadText(repository.full_name).toLowerCase() !== repo.name.toLowerCase())
    throw new GithubWebhookPayloadError()
  if (!repo.enabled) return []
  if (event === 'issues' && repo.issues) return lifecycleWebhook(repo, repositoryId, 'issue', body)
  if (event === 'pull_request' && repo.pullRequests)
    return lifecycleWebhook(repo, repositoryId, 'pr', body)
  if (
    event === 'workflow_run' &&
    repo.workflowFailures &&
    payloadText(body.action) === 'completed'
  ) {
    const run = payloadObject(body.workflow_run)
    if (run.repository !== undefined && payloadObject(run.repository).id !== repositoryId)
      throw new GithubWebhookPayloadError()
    if (
      payloadText(run.status) !== 'completed' ||
      run.conclusion === null ||
      payloadText(run.conclusion) !== 'failure'
    )
      return []
    const failure: FailureRun = {
      id: payloadId(run.id),
      run_attempt: payloadId(run.run_attempt),
      name: run.name === null ? null : payloadText(run.name),
      path: payloadText(run.path),
      head_branch: run.head_branch === null ? null : payloadText(run.head_branch),
      updated_at: payloadTime(run.updated_at),
    }
    return matchesWorkflow(repo, failure) ? [workflowFailure(repo, repositoryId, failure)] : []
  }
  if (
    event !== 'issue_comment' ||
    !(repo.mention || repo.issueComments || repo.pullRequestComments) ||
    payloadText(body.action) !== 'created'
  )
    return []
  const issue = payloadObject(body.issue)
  const kind: CommentKind = issue.pull_request == null ? 'issue' : 'pr'
  if (
    (kind === 'issue' && !repo.issueComments) ||
    (kind === 'pr' && !(repo.mention || repo.pullRequestComments))
  )
    return []
  if (kind === 'pr') payloadObject(issue.pull_request)
  const number = payloadId(issue.number)
  const raw = payloadObject(body.comment)
  const user = raw.user == null ? null : payloadObject(raw.user)
  const comment = {
    id: payloadId(raw.id),
    body: payloadText(raw.body),
    user: user && {
      login: payloadText(user.login),
      type: typeof user.type === 'string' ? user.type : undefined,
    },
    created_at: payloadTime(raw.created_at),
  }
  if (
    issue.repository_url != null &&
    payloadText(issue.repository_url).toLowerCase() !== `${API}/repos/${repo.name}`.toLowerCase()
  )
    throw new GithubWebhookPayloadError()
  if (raw.html_url != null) {
    const target = commentTarget(repo, { ...comment, html_url: payloadText(raw.html_url) })
    if (target?.kind !== kind || target.number !== number) throw new GithubWebhookPayloadError()
  }
  const match = createCommentMatcher(
    repo,
    repositoryId,
    async (n) =>
      prBase(
        new GithubApi(await getToken(), signal, fetcher),
        repoPath(repo.name),
        n,
        repositoryId,
      ),
    signal,
    readIdentity,
    ignored,
  )
  const result = await match(kind, number, comment)
  return result ? [result] : []
}

export async function pollGithub(
  repo: TriggerGithubRepository,
  previousCursor: string | null,
  token: string | undefined,
  signal: AbortSignal,
  enabledAt: string,
  fetcher: Fetch = fetch,
  pendingTrackingSince?: string | null,
  readIdentity?: GithubAppAuth['getCommentIdentity'],
): Promise<{
  cursor: string
  events: TriggerEvent[]
  ignoredComments?: TriggerIgnoredDiscussion[]
}> {
  const api = new GithubApi(token, signal, fetcher)
  const path = repoPath(repo.name)
  const now = new Date().toISOString()
  const cursor: Cursor = previousCursor
    ? JSON.parse(previousCursor)
    : {
        repositoryId: (await repositoryAt(api, path)).id,
        scannedAt: enabledAt,
        pending: [],
      }
  id(cursor.repositoryId)
  const since = Math.max(timestamp(enabledAt), timestamp(cursor.scannedAt) - OVERLAP_MS)
  const events: TriggerEvent[] = []
  const ignoredComments: TriggerIgnoredDiscussion[] = []
  if (repo.workflowFailures) await scanRuns(api, repo, path, cursor, since, events)
  const before = events.length
  const start = pendingTrackingSince ? Math.min(since, timestamp(pendingTrackingSince)) : since
  const trackingSince = Math.floor(start / 1000) * 1000
  if (repo.mention || repo.issueComments || repo.pullRequestComments)
    await scanComments(
      api,
      repo,
      path,
      cursor,
      since,
      trackingSince,
      events,
      readIdentity,
      ignoredComments,
    )
  if (repo.issues || repo.pullRequests) {
    const changes = await scanGithubLifecycle(api, repo, path, cursor.repositoryId, trackingSince)
    for (const change of changes) events.push(change)
  }
  // Issue and discussion records don't carry a repository ID. If the name was reused,
  // refuse the new scope before admitting any of its messages.
  if (
    (previousCursor ||
      repo.issues ||
      repo.pullRequests ||
      repo.issueComments ||
      repo.pullRequestComments) &&
    (events.length > before || ignoredComments.length > 0)
  ) {
    const current = await repositoryAt(api, path)
    if (
      current.id !== cursor.repositoryId ||
      current.full_name.toLowerCase() !== repo.name.toLowerCase()
    )
      throw new Error('GitHub repository identity changed; reconfigure this subscription')
  }
  cursor.scannedAt = now
  return {
    cursor: JSON.stringify(cursor),
    events,
    ...(ignoredComments.length && { ignoredComments }),
  }
}

export function isWorkflowFile(value: unknown): value is string {
  return typeof value === 'string' && /^[^/\\\p{Cc}\p{Cf}]{1,160}\.ya?ml$/u.test(value)
}

// Account lookups have no inbox event. Keep the query on a single granted repository and
// validate its identity before exposing the latest failed attempt and its bounded job facts.
export async function readRouterLatestFailure(
  name: string,
  token: string,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
  workflowFile?: string,
) {
  if (!token) throw new Error('GitHub 凭据不可用。')
  if (workflowFile !== undefined && !isWorkflowFile(workflowFile))
    throw new Error('无效的工作流文件名。')
  const api = new GithubApi(token, signal, fetcher)
  const path = repoPath(name)
  const base = `https://github.com/${name}`
  const endpoint = workflowFile
    ? `/actions/workflows/${encodeURIComponent(workflowFile)}`
    : '/actions'
  const limit = workflowFile ? 1 : 20
  const { data } = await api.page<{
    workflow_runs: Array<Run & { repository: { full_name: string } }>
  }>(`${path}${endpoint}/runs?status=failure&per_page=${limit}`)
  if (!Array.isArray(data?.workflow_runs) || data.workflow_runs.length > limit)
    throw new Error('无效的工作流列表。')
  const runs = data.workflow_runs
  for (const run of runs) {
    if (
      run.repository?.full_name?.toLowerCase() !== name.toLowerCase() ||
      run.conclusion !== 'failure' ||
      run.status !== 'completed' ||
      typeof run.path !== 'string' ||
      (workflowFile && run.path !== `.github/workflows/${workflowFile}`)
    )
      throw new Error('GitHub 返回的工作流与授权范围不符。')
  }
  const run = runs[0]
  if (!run) return { repository: name, latestFailure: null }
  const clean = (value: unknown) =>
    typeof value === 'string'
      ? value
          .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
          .trim()
          .slice(0, 160)
      : ''
  const filename = (run: Run) => run.path.replace(/^\.github\/workflows\//u, '')
  const runId = id(run.id)
  const attempt = id(run.run_attempt)
  const attemptPath = `/actions/runs/${runId}/attempts/${attempt}`
  const jobs = await api.page<Record<string, unknown>>(`${path}${attemptPath}/jobs?per_page=50`)
  if (!jobs.data) throw new Error('GitHub 未返回作业信息。')
  return {
    repository: name,
    latestFailure: {
      workflow: clean(run.name),
      workflowFile: clean(filename(run)),
      branch: clean(run.head_branch),
      occurredAt: new Date(timestamp(run.updated_at)).toISOString(),
      url: `${base}${attemptPath}`,
      facts: failedJobFacts(jobs.data, runId, attempt, base, clean).facts,
    },
    recentFailedWorkflows: [...new Set(runs.map(filename).filter(isWorkflowFile))],
  }
}
