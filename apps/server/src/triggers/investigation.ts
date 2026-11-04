import type {
  GithubInvestigation,
  GithubInvestigationAction,
  TriggerGithubRepository,
  TriggerInboxItem,
  TriggerSettingsSnapshot,
} from '@zero-os/shared'

type Fetch = (url: URL, init: RequestInit) => Promise<Response>
type Fact = GithubInvestigation['facts'][number]
type Row = Record<string, unknown>
const api = 'https://api.github.com'
const credential = /^github_listener(?:_[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?$/
const positive = /^[1-9]\d{0,15}$/

export class InvestigationError extends Error {}
function invalid(): never {
  throw new InvestigationError('GitHub 返回的记录与这条事件不符，调查已停止。')
}
function row(v: unknown): Row {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : invalid()
}
function rows(v: unknown): Row[] {
  return Array.isArray(v) ? v.map(row) : invalid()
}
function integer(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : invalid()
}
function iso(v: unknown): string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v))
    ? new Date(v).toISOString()
    : invalid()
}

export function githubEventSubject(event: TriggerInboxItem) {
  if (
    event.source !== 'github' ||
    !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(event.scope) ||
    ['.', '..'].includes(event.scope.split('/')[1])
  )
    return null
  const parts = event.eventId.split(':')
  if (
    !positive.test(parts[0]) ||
    !positive.test(parts[2]) ||
    !Number.isSafeInteger(Number(parts[0])) ||
    !Number.isSafeInteger(Number(parts[2]))
  )
    return null
  const repoId = Number(parts[0])
  if (
    parts.length === 5 &&
    parts[1] === 'run' &&
    parts[4] === 'failure' &&
    positive.test(parts[3]) &&
    Number.isSafeInteger(Number(parts[3]))
  ) {
    return { kind: 'run' as const, repoId, run: Number(parts[2]), attempt: Number(parts[3]) }
  }
  if (parts.length === 3 && parts[1] === 'comment') {
    return { kind: 'pull' as const, repoId, comment: Number(parts[2]) }
  }
  return null
}

async function limitedBody(response: Response, max: number, prefixOnly = false) {
  const reader = response.body?.getReader()
  if (!reader) throw new InvestigationError('GitHub 返回了空内容。')
  const decoder = new TextDecoder()
  let bytes = 0
  let value = ''
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      const remaining = max - bytes
      value += decoder.decode(part.value.subarray(0, remaining), { stream: true })
      bytes += part.value.byteLength
      if (bytes > max) {
        await reader.cancel()
        if (!prefixOnly) throw new InvestigationError('GitHub 返回的记录过大，请打开原始记录查看。')
        break
      }
    }
    return value + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

// Persist only these bounded verbatim runner diagnostics. Arbitrary CI output can contain secrets.
function safeDiagnostics(text: string): string[] {
  const found = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const m =
      /^(?:\d{4}-\d\d-\d\dT[\d:.]+Z\s+)?##\[error\](Process completed with exit code [0-9]{1,3}\.|The operation was canceled\.|The action has timed out\.)\s*$/.exec(
        line,
      )
    if (m) found.add(m[1])
    if (found.size >= 3) break
  }
  return [...found]
}

export interface GithubInvestigator {
  available(event: TriggerInboxItem): GithubInvestigationAction[]
  inspect(
    event: TriggerInboxItem,
    action: GithubInvestigationAction,
    signal: AbortSignal,
  ): Promise<GithubInvestigation>
}

export function createGithubInvestigator(
  settings: () => TriggerSettingsSnapshot,
  resolveSecret: (ref: string) => string | undefined,
  filter: (text: string) => string,
  fetcher: Fetch = fetch,
): GithubInvestigator {
  const clean = (text: unknown) =>
    typeof text === 'string'
      ? filter(text)
          .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
          .trim()
          .slice(0, 160)
      : ''
  function permissions(event: TriggerInboxItem) {
    const id = githubEventSubject(event)
    const snapshot = settings()
    const github = snapshot.settings.github
    const repo = github.repositories.find((r) => r.name.toLowerCase() === event.scope.toLowerCase())
    if (!repo || !id || (id.kind === 'run' ? !repo.workflowFailures : !repo.mention)) return null
    // Previously selected public events can still be read while paused, anonymously.
    const ref = repo.enabled ? github.credentialRef : ''
    return { id, repo, ref, revision: snapshot.revision }
  }
  return {
    available(event) {
      const selected = permissions(event)
      if (!selected) return []
      return selected.id.kind === 'run' ? ['inspect_github', 'compare_runs'] : ['inspect_github']
    },
    async inspect(event, action, signal) {
      const granted = permissions(event)
      if (!granted || (action === 'compare_runs' && granted.id.kind !== 'run')) {
        throw new InvestigationError('当前监听授权未包含这条 GitHub 事件。')
      }
      const { id, repo, ref } = granted
      if (ref && !credential.test(ref)) throw new InvestigationError('GitHub 监听凭证引用无效。')
      const token = ref ? resolveSecret(ref) : undefined
      if (ref && !token) throw new InvestigationError('已选择的 GitHub 监听凭证不可用。')
      const stop = AbortSignal.any([signal, AbortSignal.timeout(25_000)])
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ZeRo-OS-Investigation',
        'X-GitHub-Api-Version': '2022-11-28',
      }
      if (token) headers.Authorization = `Bearer ${token}`
      const recheck = () => {
        if (settings().revision !== granted.revision || stop.aborted)
          throw new InvestigationError('调查已中止或监听设置已更新，请重新查看。')
      }
      const request = (path: string) => {
        recheck()
        const url = new URL(`/repos/${repo.name}${path}`, api)
        return fetcher(url, { headers, signal: stop, redirect: 'manual', credentials: 'omit' })
      }
      const get = async (path: string): Promise<Row> => {
        const res = await request(path)
        if (!res.ok) {
          await res.body?.cancel()
          throw new InvestigationError(`GitHub 无法提供这项记录（HTTP ${res.status}）。`)
        }
        return row(JSON.parse(await limitedBody(res, 3_000_000)))
      }
      const repository = await get('')
      if (
        integer(repository.id) !== id.repoId ||
        typeof repository.full_name !== 'string' ||
        repository.full_name.toLowerCase() !== repo.name.toLowerCase()
      )
        invalid()
      const reader = { repo, base: `https://github.com/${repo.name}`, clean, get, request }
      const result =
        id.kind === 'pull'
          ? await readPull(id, reader)
          : await readRun(id, action, reader, stop, fetcher)
      recheck()
      return { ...result, observedAt: new Date().toISOString() }
    },
  }
}

interface RepositoryReader {
  repo: TriggerGithubRepository
  base: string
  get(path: string): Promise<Row>
  request(path: string): Promise<Response>
  clean(text: unknown): string
}
type RunSubject = Extract<NonNullable<ReturnType<typeof githubEventSubject>>, { kind: 'run' }>
type CommentSubject = Extract<NonNullable<ReturnType<typeof githubEventSubject>>, { kind: 'pull' }>

async function readPull(id: CommentSubject, { repo, base, get, clean }: RepositoryReader) {
  const comment = await get(`/issues/comments/${id.comment}`)
  if (integer(comment.id) !== id.comment || typeof comment.issue_url !== 'string') invalid()
  const issue = new URL(comment.issue_url)
  const n = issue.pathname.split('/').at(-1) ?? ''
  if (
    !positive.test(n) ||
    !Number.isSafeInteger(Number(n)) ||
    issue.href.toLowerCase() !== `${api}/repos/${repo.name}/issues/${n}`.toLowerCase()
  )
    invalid()
  const pr = await get(`/pulls/${n}`)
  const baseRef = row(pr.base)
  if (
    integer(pr.number) !== Number(n) ||
    (pr.state !== 'open' && pr.state !== 'closed') ||
    row(baseRef.repo).id !== id.repoId ||
    (repo.branch && baseRef.ref !== repo.branch)
  )
    invalid()
  const mention = repo.mention.replace(/^@/, '')
  if (
    !/^[a-z\d-]+(?:\[bot\])?$/i.test(mention) ||
    typeof comment.body !== 'string' ||
    !new RegExp(
      `(?:^|[^a-z0-9_@./-])@${mention.replace(/[\[\]]/g, '\\$&')}(?![a-z0-9_-])`,
      'i',
    ).test(comment.body)
  )
    throw new InvestigationError('原评论不再符合当前的账号提及规则。')
  const sourceUrl = `${base}/pull/${n}#issuecomment-${id.comment}`
  const facts: Fact[] = [
    { label: `PR #${n}`, value: clean(pr.title) },
    {
      label: '当前状态',
      value: pr.merged_at ? '已合并' : pr.state === 'open' ? '打开' : '已关闭',
    },
    { label: '目标分支', value: clean(baseRef.ref) },
    { label: '评论时间', value: iso(comment.created_at) },
  ]
  return { kind: 'pull' as const, facts, sourceUrl }
}

async function readRun(
  id: RunSubject,
  action: GithubInvestigationAction,
  reader: RepositoryReader,
  stop: AbortSignal,
  fetcher: Fetch,
) {
  const { repo, base, get } = reader
  const path = `/actions/runs/${id.run}/attempts/${id.attempt}`
  const run = await get(path)
  if (
    integer(run.id) !== id.run ||
    row(run.repository).id !== id.repoId ||
    integer(run.run_attempt) !== id.attempt ||
    run.conclusion !== 'failure' ||
    !matchesRule(repo, run)
  )
    invalid()
  const sourceUrl = `${base}${path}`

  const kind: 'history' | 'jobs' = action === 'compare_runs' ? 'history' : 'jobs'
  const facts =
    kind === 'history'
      ? await historyFacts(id, run, reader)
      : await jobFacts(id, path, reader, stop, fetcher)
  return { kind, facts, sourceUrl }
}

async function historyFacts(
  id: RunSubject,
  run: Row,
  { base, get, clean }: RepositoryReader,
): Promise<Fact[]> {
  const facts: Fact[] = []
  const number = integer(run.run_number)
  const workflow = integer(run.workflow_id)
  const created = iso(run.created_at)
  const branch = typeof run.head_branch === 'string' ? run.head_branch : null
  if (id.attempt > 1) {
    const previous = await get(`/actions/runs/${id.run}/attempts/${id.attempt - 1}`)
    if (
      integer(previous.id) !== id.run ||
      integer(previous.run_attempt) !== id.attempt - 1 ||
      row(previous.repository).id !== id.repoId
    )
      invalid()
    facts.push({
      label: '同一次运行的上一次尝试',
      value: `第 ${id.attempt - 1} 次 · ${clean(previous.conclusion ?? previous.status)}`,
      url: `${base}/actions/runs/${id.run}/attempts/${id.attempt - 1}`,
    })
  }
  const headRepoId = (run.head_repository as Row | null)?.id
  if (
    branch &&
    typeof headRepoId === 'number' &&
    Number.isSafeInteger(headRepoId) &&
    headRepoId > 0
  ) {
    const params = new URLSearchParams({ branch, created: `<=${created}`, per_page: '20' })
    const previous = await get(`/actions/workflows/${workflow}/runs?${params}`)
    const related = rows(previous.workflow_runs)
      .filter(
        (prior) =>
          prior.id !== run.id &&
          row(prior.repository).id === id.repoId &&
          prior.workflow_id === workflow &&
          prior.head_branch === branch &&
          prior.event === run.event &&
          integer(prior.run_number) < number &&
          iso(prior.created_at) <= created &&
          (prior.head_repository as Row | null)?.id === headRepoId,
      )
      .sort((a, b) => Number(b.run_number) - Number(a.run_number))
      .slice(0, 4)
    for (const prior of related)
      facts.push({
        label: `之前的运行 #${prior.run_number}`,
        value: `${iso(prior.created_at)} · ${clean(prior.conclusion ?? prior.status)}`,
        url: `${base}/actions/runs/${integer(prior.id)}`,
      })
    if (!related.length)
      facts.push({
        label: '对比范围',
        value: '查询的最多 20 项中，没有同工作流、同分支、同触发方式的更早运行。',
      })
  } else facts.push({ label: '对比范围', value: '缺少可核对的来源仓库或分支，未比较其他运行。' })
  return facts
}

async function jobFacts(
  id: RunSubject,
  path: string,
  { base, repo, get, request, clean }: RepositoryReader,
  stop: AbortSignal,
  fetcher: Fetch,
): Promise<Fact[]> {
  const facts: Fact[] = []
  const data = await get(`${path}/jobs?per_page=50`)
  const jobs = rows(data.jobs)
  if (
    typeof data.total_count !== 'number' ||
    !Number.isSafeInteger(data.total_count) ||
    data.total_count < jobs.length ||
    jobs.length > 50
  )
    invalid()
  const failed = jobs.filter((job) => {
    if (job.run_id !== id.run || job.run_attempt !== id.attempt) invalid()
    return job.conclusion === 'failure' || job.conclusion === 'timed_out'
  })
  facts.push({
    label: '检查范围',
    value: `本次尝试共 ${data.total_count} 项作业，检查前 ${jobs.length} 项，发现 ${failed.length} 项失败或超时。`,
  })
  for (const job of failed.slice(0, 4)) {
    const steps = rows(job.steps ?? []).filter(
      (s) => s.conclusion === 'failure' || s.conclusion === 'timed_out',
    )
    facts.push({
      label: clean(job.name),
      value: steps.length
        ? steps
            .slice(0, 4)
            .map((s) => `步骤 ${integer(s.number)} · ${clean(s.name)}`)
            .join('；')
        : 'GitHub 未标出失败步骤。',
      url: `${base}/actions/runs/${id.run}/job/${integer(job.id)}`,
    })
  }
  if (failed.length) {
    const checkUrl = failed[0].check_run_url
    const checkId = typeof checkUrl === 'string' ? (checkUrl.split('/').at(-1) ?? '') : ''
    if (positive.test(checkId) && checkUrl === `${api}/repos/${repo.name}/check-runs/${checkId}`) {
      const annotations = await request(`/check-runs/${checkId}/annotations?per_page=10`)
      if (annotations.ok) {
        const safe = rows(JSON.parse(await limitedBody(annotations, 500_000)))
          .filter(
            (annotation) =>
              annotation.annotation_level === 'failure' &&
              typeof annotation.message === 'string' &&
              /^(?:Process completed with exit code [0-9]{1,3}\.|One or more formatters failed|(?:Clang-format|Prettier|ESLint|Biome|TypeScript|Tests) failed[.!]?)$/i.test(
                annotation.message,
              ),
          )
          .slice(0, 3)
          .map((annotation) => clean(annotation.message))
        if (safe.length) facts.push({ label: 'GitHub Checks 的失败标注', value: safe.join(' · ') })
      } else await annotations.body?.cancel()
    }
    const logs = await request(`/actions/jobs/${integer(failed[0].id)}/logs`)
    const detail = await jobLog(logs, stop, fetcher)
    facts.push({ label: '首个失败作业的日志', value: detail })
  }
  return facts
}

function matchesRule(repo: TriggerGithubRepository, run: Row) {
  return (
    (!repo.branch || repo.branch === run.head_branch) &&
    (!repo.workflow || repo.workflow === run.name || repo.workflow === run.path)
  )
}

async function jobLog(initial: Response, signal: AbortSignal, fetcher: Fetch) {
  let res = initial
  if (initial.status === 302) {
    const location = initial.headers.get('location')
    await initial.body?.cancel()
    const url = location && URL.canParse(location) ? new URL(location) : null
    if (
      !url ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !/^(?:[a-z0-9-]+\.actions\.githubusercontent\.com|(?:productionresultssa|pipelinesactions)[a-z0-9]{1,20}\.blob\.core\.windows\.net)$/.test(
        url.hostname,
      )
    )
      return 'GitHub 提供的日志下载地址未获允许。'
    try {
      // The signed URL is short lived. No API headers, credentials, redirect or URL are retained.
      res = await fetcher(url, { signal, redirect: 'manual', credentials: 'omit' })
    } catch (error) {
      if (signal.aborted) throw error
      return '日志下载未完成。'
    }
  }
  if (!res.ok) {
    await res.body?.cancel()
    return `日志未能读取（HTTP ${res.status}）。`
  }
  if (/zip|application\/gzip/i.test(res.headers.get('content-type') ?? '')) {
    await res.body?.cancel()
    return 'GitHub 提供了归档文件，此处只读取纯文本作业日志。'
  }
  const findings = safeDiagnostics(await limitedBody(res, 256_000, true))
  return findings.length
    ? findings.join('\n')
    : '检查了最多 256 KB，未发现可安全展示的运行器错误行。'
}
