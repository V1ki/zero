import type { GithubAppMergeAuth } from './github-app-auth'

type Pull = {
  number: number
  head: { sha: string }
  base: { repo: { full_name: string } }
  draft: boolean
  state: string
  merged: boolean
  merged_by: { login: string } | null
  merge_commit_sha: string | null
}

/** Merge only the reviewed head. A lost acknowledgement is resolved by reading the PR, never another PUT. */
export async function mergeGithubAppPull(
  auth: GithubAppMergeAuth,
  input: {
    ref: string
    repository: string
    number: number
    head: string
    signal: AbortSignal
    beforeWrite(): void
  },
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
) {
  const { repository, number, head, signal } = input
  const { token, botLogin } = await auth.getMergeAccess(input.ref, repository, signal)
  const url = new URL(`https://api.github.com/repos/${repository}/pulls/${number}`)
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'ZeRo-OS-Trigger',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
  const request = { headers, signal, redirect: 'manual' as const }
  const link = `https://github.com/${repository}/pull/${number}`
  async function read() {
    const response = await fetcher(url, request)
    if (!response.ok) throw Error(`无法核对 PR（HTTP ${response.status}）。`)
    const pull = (await response.json()) as Pull
    if (
      pull?.number !== number ||
      pull.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      pull.head?.sha !== head
    )
      throw Error('PR 仓库、编号或提交与已审版本不符，请重新审阅。')
    return pull
  }
  const receipt = (pull: Pull, status: 'merged' | 'already_merged') => {
    if (pull.merged !== true || !pull.merge_commit_sha || !pull.merged_by?.login)
      throw Error('GitHub 尚未返回完整合并回执。')
    return { status, author: pull.merged_by.login, url: link, head, commit: pull.merge_commit_sha }
  }
  const prior = await read()
  if (prior.merged) return receipt(prior, 'already_merged')
  if (prior.state !== 'open' || prior.draft !== false)
    throw Error('只有开放且已结束草稿状态的 PR 可以合并。')
  signal.throwIfAborted()
  input.beforeWrite()
  const uncertain = () => new Error(`合并结果待核对，请先读取 ${link} 的实际状态和合并者。`)
  const response = await fetcher(new URL(`${url.href}/merge`), {
    ...request,
    method: 'PUT',
    body: JSON.stringify({ sha: head }),
  }).catch(() => null)
  if (response && response.status >= 400 && response.status < 500 && response.status !== 408) {
    await response.body?.cancel()
    throw Error(
      `GitHub 拒绝合并（HTTP ${response.status}）。请核对提交版本、仓库规则和 App 安装权限。`,
    )
  }
  await response?.body?.cancel()
  // The platform's current PR record identifies the actual actor, including a concurrent merge.
  const after = await read().catch(() => {
    throw uncertain()
  })
  if (!after.merged || !after.merge_commit_sha || !after.merged_by?.login) throw uncertain()
  return receipt(after, after.merged_by.login === botLogin ? 'merged' : 'already_merged')
}
