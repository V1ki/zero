import type { GithubAppPullAuth } from './github-app-auth'

type Pull = {
  number: number
  head: { ref: string; repo: { full_name: string }; sha: string }
  base: { ref: string; repo: { full_name: string } }
  user: { login: string; type: string }
  html_url: string
}

/** Reuse the open PR for the same branch, even if another author opened it. */
export async function openGithubAppPull(
  auth: GithubAppPullAuth,
  input: {
    repository: string
    ref: string
    head: string
    base: string
    title: string
    body: string
    signal: AbortSignal
    beforeWrite(): void
  },
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
) {
  const { repository, ref, head, base, title, body, signal } = input
  const { token, botLogin } = await auth.getPullAccess(ref, repository, signal)
  const url = new URL(`https://api.github.com/repos/${repository}/pulls`)
  const options = {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ZeRo-OS-Trigger',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    redirect: 'manual' as const,
    signal,
  }
  const matching = new URL(url)
  matching.searchParams.set('head', `${repository.split('/')[0]}:${head}`)
  matching.searchParams.set('base', base)
  matching.searchParams.set('state', 'open')
  function receipt(p: Pull, status: 'existing' | 'created') {
    if (
      !Number.isSafeInteger(p?.number) ||
      p.number <= 0 ||
      p.head?.ref !== head ||
      p.base?.ref !== base ||
      p.head.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      p.base.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      !p.user?.login ||
      p.html_url?.toLowerCase() !==
        `https://github.com/${repository.toLowerCase()}/pull/${p.number}` ||
      (status === 'created' && (p.user.type !== 'Bot' || p.user.login !== botLogin))
    )
      throw Error('PR 回执中的仓库、分支或作者与预期不符，请核对 GitHub。')
    return { status, number: p.number, author: p.user.login, url: p.html_url, head: p.head.sha }
  }
  async function existing() {
    const r = await fetcher(matching, options)
    if (!r.ok) throw Error(`无法核对已有 PR（HTTP ${r.status}）。`)
    const pulls = (await r.json()) as Pull[]
    if (!Array.isArray(pulls)) throw Error('GitHub 返回了无效的 PR 清单。')
    return pulls.length ? receipt(pulls[0], 'existing') : null
  }
  const found = await existing()
  if (found) return found
  signal.throwIfAborted()
  input.beforeWrite()
  const r = await fetcher(url, {
    ...options,
    method: 'POST',
    body: JSON.stringify({ head, base, title, body }),
  }).catch(() => null)
  if (r?.status === 201) {
    const pull = await r.json().catch(() => null)
    return receipt(pull, 'created')
  }
  await r?.body?.cancel()
  if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 422)
    throw Error(`GitHub 拒绝创建 PR（HTTP ${r.status}）。`)
  const recovered = await existing().catch(() => null)
  if (recovered) return recovered
  if (r?.status === 422) throw Error('GitHub 未接受这个 PR，请核对远端分支、目标分支及提交差异。')
  throw Error('创建 PR 的结果待核对，请先查看仓库中的开放 PR。')
}
