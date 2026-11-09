/** Repository-scoped, authenticated read capabilities. Resource selection is left to the Agent. */
export const githubReadResources = [
  'repository',
  'issues',
  'pulls',
  'issue',
  'comments',
  'pull',
  'files',
  'reviews',
  'review_comments',
  'checks',
  'statuses',
  'tree',
  'file',
] as const
export interface GithubRepositoryRead {
  resource: (typeof githubReadResources)[number]
  number?: number
  page?: number
  ref?: string
  path?: string
  offset?: number
  expectedHead?: string
}
export class GithubRepositoryReadError extends Error {}
type Fetch = (url: URL, init: RequestInit) => Promise<Response>
type Row = Record<string, unknown>
const row = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}
const pick = (value: unknown, keys: string[]) =>
  Object.fromEntries(
    keys.filter((k) => Object.hasOwn(row(value), k)).map((k) => [k, row(value)[k]]),
  )
const sha = /^[a-f0-9]{40}$/i

export async function readGithubRepositoryResource(
  repository: string,
  token: string,
  input: GithubRepositoryRead,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
) {
  if (
    !/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(repository) ||
    ['.', '..'].includes(repository.split('/')[1])
  )
    throw new GithubRepositoryReadError('仓库名称无效。')
  const page = input.page ?? 1
  const offset = input.offset ?? 0
  if (
    !githubReadResources.includes(input.resource) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new GithubRepositoryReadError('资料类型、页码或正文位置无效。')
  if (
    !['repository', 'issues', 'pulls', 'tree', 'file'].includes(input.resource) &&
    (!Number.isSafeInteger(input.number) || input.number! < 1)
  )
    throw new GithubRepositoryReadError('需要有效的 Issue 或 PR 编号。')
  if (input.expectedHead !== undefined && !sha.test(input.expectedHead))
    throw new GithubRepositoryReadError('expectedHead 需要完整提交 SHA。')
  if (['tree', 'file'].includes(input.resource) && input.ref !== undefined && !sha.test(input.ref))
    throw new GithubRepositoryReadError('代码读取的 ref 需要完整提交 SHA；省略时使用当前默认分支。')
  const stop = AbortSignal.any([signal, AbortSignal.timeout(25000)])
  const root = `/repos/${repository}`
  const request = async (path: string) => {
    stop.throwIfAborted()
    const url = new URL(`https://api.github.com${root}${path}`)
    const res = await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: stop,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ZeRo-Repository-Reader',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok) {
      await res.body?.cancel()
      const remaining = res.headers.get('x-ratelimit-remaining')
      const reset = res.headers.get('x-ratelimit-reset')
      const retry = res.headers.get('retry-after')
      const limited = res.status === 429 || remaining === '0' || retry !== null
      throw new GithubRepositoryReadError(
        `GitHub 认证读取失败：HTTP ${res.status}，${limited ? '限流' : res.status === 403 ? '访问被拒绝，未证实为限流' : '未取得资料'}；resource=${input.resource}，remaining=${remaining ?? 'unknown'}，reset=${reset ?? 'unknown'}，retryAfter=${retry ?? 'unknown'}，requestId=${res.headers.get('x-github-request-id') ?? 'unknown'}。`,
      )
    }
    const chunks: Uint8Array[] = []
    const reader = res.body?.getReader()
    let size = 0
    if (!reader) throw new GithubRepositoryReadError('GitHub 返回空响应。')
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 3_000_000) {
        await reader.cancel()
        throw new GithubRepositoryReadError('资料超过单次读取范围，请缩小文件或页范围。')
      }
      chunks.push(part.value)
    }
    stop.throwIfAborted()
    return {
      data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      nextPage: /rel="next"/.test(res.headers.get('link') ?? '') ? page + 1 : null,
    }
  }
  const { resource, number } = input
  let head: string | undefined
  let base: string | undefined
  let subject: unknown
  if (['pull', 'files', 'reviews', 'review_comments', 'checks', 'statuses'].includes(resource)) {
    subject = (await request(`/pulls/${number}`)).data
    head = String(row(row(subject).head).sha ?? '')
    base = String(row(row(subject).base).sha ?? '')
    if (!sha.test(head) || !sha.test(base))
      throw new GithubRepositoryReadError('PR 缺少可核对的提交版本。')
    if (input.expectedHead && head !== input.expectedHead)
      throw new GithubRepositoryReadError('PR 版本已变化，请重新核对。')
  }
  let ref = input.ref
  if (['tree', 'file'].includes(resource) && !ref) {
    const repo = row((await request('')).data)
    const commit = row(
      (await request(`/commits/${encodeURIComponent(String(repo.default_branch))}`)).data,
    )
    ref = String(commit.sha ?? '')
    if (!sha.test(ref)) throw new GithubRepositoryReadError('无法解析默认分支的提交版本。')
  }
  if (
    resource === 'file' &&
    (!input.path ||
      input.path.length > 1000 ||
      input.path.split('/').some((s) => !s || s === '.' || s === '..' || s.includes('\\')))
  )
    throw new GithubRepositoryReadError('文件路径需要仓库内的相对路径。')
  const paths: Record<GithubRepositoryRead['resource'], string> = {
    repository: '',
    issues: '/issues?state=open',
    pulls: '/pulls?state=open',
    issue: `/issues/${number}`,
    comments: `/issues/${number}/comments`,
    pull: `/pulls/${number}`,
    files: `/pulls/${number}/files`,
    reviews: `/pulls/${number}/reviews`,
    review_comments: `/pulls/${number}/comments`,
    checks: `/commits/${head}/check-runs`,
    statuses: `/commits/${head}/status`,
    tree: `/git/trees/${ref}?recursive=1`,
    file: `/contents/${input.path?.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`,
  }
  const paginated = !['repository', 'issue', 'pull', 'tree', 'file'].includes(resource)
  const path =
    paths[resource] +
    (paginated ? `${paths[resource].includes('?') ? '&' : '?'}per_page=30&page=${page}` : '')
  const result = resource === 'pull' ? { data: subject, nextPage: null } : await request(path)
  let data = result.data
  if (resource === 'repository')
    data = pick(data, [
      'full_name',
      'html_url',
      'description',
      'default_branch',
      'visibility',
      'archived',
      'license',
      'pushed_at',
    ])
  if (resource === 'issues' || resource === 'pulls') {
    if (!Array.isArray(data)) throw new GithubRepositoryReadError('列表响应结构无效。')
    data = data
      .filter((v) => resource !== 'issues' || !row(v).pull_request)
      .map((v) =>
        pick(v, [
          'number',
          'title',
          'html_url',
          'state',
          'draft',
          'updated_at',
          'labels',
          'comments',
        ]),
      )
  }
  if (resource === 'files') {
    const current = row((await request(`/pulls/${number}`)).data)
    if (row(current.head).sha !== head || row(current.base).sha !== base)
      throw new GithubRepositoryReadError('读取补丁期间 PR 版本已变化，请重新核对。')
    if (Array.isArray(data))
      data = data.map((v) =>
        pick(v, [
          'filename',
          'previous_filename',
          'status',
          'additions',
          'deletions',
          'changes',
          'patch',
          'blob_url',
        ]),
      )
  }
  if (resource === 'file') {
    const file = row(data)
    if (file.encoding !== 'base64' || typeof file.content !== 'string')
      throw new GithubRepositoryReadError('文件未提供正文，请使用有工作区的执行器读取。')
    data = {
      path: file.path,
      sha: file.sha,
      ref,
      content: Buffer.from(file.content, 'base64').toString('utf8'),
    }
  }
  const encoded = JSON.stringify(data)
  const end = Math.min(encoded.length, offset + 24000)
  return {
    repository,
    resource,
    observedAt: new Date().toISOString(),
    sourceUrl: `https://api.github.com${root}${path}`,
    page,
    nextPage: result.nextPage,
    head,
    base,
    ref,
    content: encoded.slice(offset, end),
    offset,
    totalCharacters: encoded.length,
    nextOffset: end < encoded.length ? end : null,
    coverage:
      '仅当前响应与正文分段；nextPage 或 nextOffset 非空需继续。tree.truncated、缺少 patch 或检查数据不完整均不能当作完整代码审查；本工具不执行测试。',
  }
}
