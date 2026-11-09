import type { GithubAppCommentAuth } from './github-app-auth'

interface CommentRequest {
  ref: string
  repository: string
  issueNumber: number
  body: string
  signal: AbortSignal
  expectedAuthor?: string
  expectedRepositoryId?: number
  /** For unattended posts, verify the original request with GitHub after minting the token. */
  verifyRequest?: (signal: AbortSignal) => Promise<boolean>
  /** Re-check the saved repository binding after the asynchronous token exchange. */
  beforePost?: () => void
}

export interface GithubAppCommentReceipt {
  id: number
  url: string
  author: string
}

type Fetch = (url: URL, init: RequestInit) => Promise<Response>
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export class GithubAppCommentUncertainError extends Error {
  constructor() {
    super('GitHub 评论发送结果待核对。请先查看原讨论，避免重复发送。')
  }
}
export class GithubAppCommentRejectedError extends Error {
  constructor(status: number, headers = new Headers()) {
    const fields = [
      'x-github-request-id',
      'x-accepted-github-permissions',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      'retry-after',
    ].flatMap((name) => (headers.has(name) ? [name + '=' + headers.get(name)] : []))
    super(`GitHub 拒绝发布评论（HTTP ${status}）。` + fields.join('，'))
  }
}

/** Issue threads and PR conversations use the same create-comment endpoint. */
export async function postGithubAppComment(
  auth: GithubAppCommentAuth,
  {
    ref,
    repository,
    issueNumber,
    body,
    signal,
    expectedAuthor,
    expectedRepositoryId,
    verifyRequest,
    beforePost,
  }: CommentRequest,
  fetcher: Fetch = fetch,
): Promise<GithubAppCommentReceipt> {
  if (!/^[a-z\d-]+\/[a-z\d_.-]+$/iu.test(repository) || /\/\.{1,2}$/u.test(repository))
    throw new Error('请输入有效的 GitHub 仓库全名。')
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
    throw new Error('请输入有效的 Issue 或 PR 编号。')
  if (!body.trim() || body.length > 65_536) throw new Error('评论正文长度应为 1 至 65536 个字符。')
  if (
    expectedRepositoryId !== undefined &&
    (!Number.isSafeInteger(expectedRepositoryId) || expectedRepositoryId < 1)
  )
    throw new Error('GitHub 仓库 ID 无效，未发布评论。')
  const { token, botLogin } = await auth.getCommentAccess(ref, repository, signal)
  if (expectedAuthor !== undefined && expectedAuthor !== botLogin)
    throw new Error('GitHub App 身份与预览不符，未发布评论。')
  const repo = new URL(`https://api.github.com/repos/${repository}`)
  const item = new URL(`${repo.href}/issues/${issueNumber}`)
  const stop = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ZeRo-OS-Trigger',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
  }
  if (expectedRepositoryId !== undefined) {
    const failure = () => new Error('未能核对 GitHub 仓库身份，未发布评论。')
    const info = await fetcher(repo, {
      method: 'GET',
      redirect: 'manual',
      signal: stop,
      headers,
    }).catch(() => {
      throw failure()
    })
    if (info.status !== 200) {
      await info.body?.cancel()
      throw failure()
    }
    const target: unknown = await info.json().catch(() => {
      throw failure()
    })
    if (
      !record(target) ||
      target.id !== expectedRepositoryId ||
      typeof target.full_name !== 'string' ||
      target.full_name.toLowerCase() !== repository.toLowerCase()
    )
      throw failure()
  }
  if (verifyRequest && !(await verifyRequest(stop))) throw new Error('原评论的回复授权已失效。')
  stop.throwIfAborted()
  beforePost?.()
  // A second POST can publish a duplicate when GitHub accepted the first but lost its response.
  const response = await fetcher(new URL(`${item.href}/comments`), {
    method: 'POST',
    redirect: 'manual',
    signal: stop,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  }).catch(() => {
    throw new GithubAppCommentUncertainError()
  })

  if (response.status !== 201) {
    await response.body?.cancel()
    if (response.status >= 400 && response.status < 500 && response.status !== 408)
      throw new GithubAppCommentRejectedError(response.status, response.headers)
    throw new GithubAppCommentUncertainError()
  }
  const result: unknown = await response.json().catch(() => {
    throw new GithubAppCommentUncertainError()
  })
  if (
    !record(result) ||
    typeof result.id !== 'number' ||
    !Number.isSafeInteger(result.id) ||
    result.id <= 0 ||
    !record(result.user) ||
    result.user.type !== 'Bot' ||
    result.user.login !== botLogin ||
    typeof result.issue_url !== 'string' ||
    result.issue_url.toLowerCase() !== item.href.toLowerCase() ||
    typeof result.html_url !== 'string'
  )
    throw new GithubAppCommentUncertainError()
  const html = result.html_url.toLowerCase()
  const expected = (type: 'issues' | 'pull') =>
    `https://github.com/${repository.toLowerCase()}/${type}/${issueNumber}#issuecomment-${result.id}`
  if (html !== expected('issues') && html !== expected('pull'))
    throw new GithubAppCommentUncertainError()
  return { id: result.id, url: result.html_url, author: botLogin }
}
