import type {
  TriggerEvent,
  TriggerGithubPermissionReport,
  TriggerGithubPermissionSelection,
  TriggerGithubRepository,
  TriggerRepositoryOption,
} from '@zero-os/shared'
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
    private signal: AbortSignal,
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
  html_url: string
  user: { login: string } | null
}

interface Cursor {
  repositoryId: number
  scannedAt: string
  pending: number[]
  runsEtag?: string
  comments?: { path: string; etag: string }
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
  if (selection.prBase) resources.push(['prBase', 'pulls'])
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
  return {
    access: token ? 'credential' : 'anonymous',
    checks: await Promise.all(resources.map(probe)),
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
    if (run.repository && run.repository.id !== cursor.repositoryId)
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

function prMention(
  repo: TriggerGithubRepository,
  repositoryId: number,
  number: number,
  login: string,
  comment: Omit<Comment, 'html_url'>,
): TriggerEvent {
  return {
    eventId: `${repositoryId}:comment:${id(comment.id)}`,
    scope: repo.name,
    title: `PR #${number} · @${login}`,
    summary: `${comment.user?.login ?? '未知作者'}：${comment.body.slice(0, 300)}`,
    occurredAt: comment.created_at,
    url: `https://github.com/${repo.name}/pull/${number}#issuecomment-${comment.id}`,
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
  since: number,
  events: TriggerEvent[],
) {
  const login = repo.mention.replace(/^@/, '')
  const mention = mentionPattern(login)
  // Reuse conditional GET only for an identical page and query window.
  const from = new Date(Math.floor(since / 60_000) * 60_000).toISOString()
  const firstPath = `${path}/issues/comments?per_page=100&sort=updated&direction=asc&since=${encodeURIComponent(from)}`
  const filter = cursor.comments?.path === firstPath ? cursor.comments.etag : undefined
  let next: string | null = firstPath
  const bases = new Map<number, string>()
  while (next) {
    const page: Page<Comment[]> = await api.page(next, next === firstPath ? filter : undefined)
    if (!page.data) return
    if (next === firstPath) {
      cursor.comments = !page.next && page.etag ? { path: firstPath, etag: page.etag } : undefined
    }
    for (const comment of page.data) {
      if (timestamp(comment.created_at) < since || !mention.test(comment.body)) continue
      const url = new URL(comment.html_url)
      const parts = url.pathname.split('/')
      if (
        url.origin !== 'https://github.com' ||
        parts[3] !== 'pull' ||
        parts.length !== 5 ||
        !/^\d+$/.test(parts[4])
      )
        continue
      const number = id(Number(parts[4]))
      if (repo.branch) {
        if (!bases.has(number)) {
          bases.set(number, await prBase(api, path, number, cursor.repositoryId))
        }
        if (bases.get(number) !== repo.branch) continue
      }
      events.push(prMention(repo, cursor.repositoryId, number, login, comment))
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

/** The HTTP receiver authenticates the original bytes before handing off the JSON here. */
export async function normalizeGithubWebhook(
  repo: TriggerGithubRepository,
  event: string,
  payload: unknown,
  getToken: () => string | undefined,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
): Promise<TriggerEvent[]> {
  const body = payloadObject(payload)
  const repository = payloadObject(body.repository)
  const repositoryId = payloadId(repository.id)
  if (payloadText(repository.full_name).toLowerCase() !== repo.name.toLowerCase())
    throw new GithubWebhookPayloadError()
  if (!repo.enabled) return []
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
  if (event !== 'issue_comment' || !repo.mention || payloadText(body.action) !== 'created')
    return []
  const issue = payloadObject(body.issue)
  if (issue.pull_request == null) return []
  payloadObject(issue.pull_request)
  const number = payloadId(issue.number)
  const raw = payloadObject(body.comment)
  const login = repo.mention.replace(/^@/, '')
  const text = payloadText(raw.body)
  if (!mentionPattern(login).test(text)) return []
  const comment = {
    id: payloadId(raw.id),
    body: text,
    user: raw.user == null ? null : { login: payloadText(payloadObject(raw.user).login) },
    created_at: payloadTime(raw.created_at),
  }
  if (repo.branch) {
    const api = new GithubApi(getToken(), signal, fetcher)
    const branch = await prBase(api, repoPath(repo.name), number, repositoryId)
    if (branch !== repo.branch) return []
  }
  return [prMention(repo, repositoryId, number, login, comment)]
}

export async function pollGithub(
  repo: TriggerGithubRepository,
  previousCursor: string | null,
  token: string | undefined,
  signal: AbortSignal,
  enabledAt: string,
  fetcher: Fetch = fetch,
): Promise<{ cursor: string; events: TriggerEvent[] }> {
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
  if (repo.workflowFailures) await scanRuns(api, repo, path, cursor, since, events)
  if (repo.mention) {
    const before = events.length
    await scanComments(api, repo, path, cursor, since, events)
    // Discussion records don't carry a repository ID. If a repository name
    // was reused, refuse the new scope before admitting any of its messages.
    if (
      previousCursor &&
      events.length > before &&
      (await repositoryAt(api, path)).id !== cursor.repositoryId
    ) {
      throw new Error('GitHub repository identity changed; reconfigure this subscription')
    }
  }
  cursor.scannedAt = now
  return { cursor: JSON.stringify(cursor), events }
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
