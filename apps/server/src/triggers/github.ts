import type {
  TriggerEvent,
  TriggerGithubRepository,
  TriggerRepositoryOption,
} from '@zero-os/shared'

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

class GithubApi {
  constructor(
    private token: string | undefined,
    private signal: AbortSignal,
    private fetcher: Fetch,
  ) {}

  async page<T>(path: string, etag?: string): Promise<Page<T>> {
    let url = safeUrl(path)
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ZeRo-OS-Trigger',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
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
  name: string
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
    const page: Page<Repository[]> = await api.page(path)
    for (const repo of page.data ?? []) {
      repoPath(repo.full_name)
      names.add(repo.full_name)
    }
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
    if (repo.branch && run.head_branch !== repo.branch) return
    if (repo.workflow && repo.workflow !== run.name && repo.workflow !== run.path) return
    if (run.status !== 'completed') {
      if (pending.has(run.id) || timestamp(run.updated_at) >= since) pending.add(run.id)
      return
    }
    const wasPending = pending.delete(run.id)
    if (run.conclusion !== 'failure' || (!wasPending && timestamp(run.updated_at) < since)) return
    const attempt = id(run.run_attempt ?? 1)
    const eventId = `${cursor.repositoryId}:run:${run.id}:${attempt}:failure`
    if (seenEvents.has(eventId)) return
    seenEvents.add(eventId)
    events.push({
      eventId,
      scope: repo.name,
      occurredAt: run.updated_at,
      title: `${run.name} 工作流失败`,
      summary: `${repo.name} · ${run.head_branch ?? '无分支'} · 第 ${attempt} 次运行`,
      url: `https://github.com/${repo.name}/actions/runs/${run.id}/attempts/${attempt}`,
    })
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

async function scanComments(
  api: GithubApi,
  repo: TriggerGithubRepository,
  path: string,
  cursor: Cursor,
  since: number,
  events: TriggerEvent[],
) {
  const login = repo.mention.replace(/^@/, '')
  if (!/^[a-z\d-]+(?:\[bot\])?$/i.test(login)) throw new Error('Invalid GitHub mention')
  const mention = new RegExp(
    `(?:^|[^a-z0-9_@./-])@${login.replace(/[\[\]]/g, '\\$&')}(?![a-z0-9_-])`,
    'i',
  )
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
          const { data } = await api.page<{ base: { ref: string } }>(`${path}/pulls/${number}`)
          if (!data?.base?.ref) throw new Error('Missing GitHub pull request branch')
          bases.set(number, data.base.ref)
        }
        if (bases.get(number) !== repo.branch) continue
      }
      events.push({
        eventId: `${cursor.repositoryId}:comment:${id(comment.id)}`,
        scope: repo.name,
        title: `PR #${number} · @${login}`,
        summary: `${comment.user?.login ?? '未知作者'}：${comment.body.slice(0, 300)}`,
        occurredAt: comment.created_at,
        url: `https://github.com/${repo.name}/pull/${number}#issuecomment-${comment.id}`,
      })
    }
    next = page.next
  }
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
