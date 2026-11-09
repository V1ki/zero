import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { GithubAppMergeAuth } from './github-app-auth'

const exec = promisify(execFile)

type BranchInput = {
  repository: string
  ref: string
  branch: string
  head: string
  source: string
  signal: AbortSignal
  beforeWrite(): void
}

/** Publish the original commit object, retaining its author and both parents for merge candidates. */
async function pushCommit(input: BranchInput, token: string) {
  const source = await realpath(input.source)
  const directory = await mkdtemp(join(tmpdir(), 'zero-app-branch-'))
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
  const options = { cwd: directory, env, signal: input.signal }
  try {
    await exec('git', ['init', '--bare', '--template='], options)
    // Import without credentials; only this clean repository performs the network write.
    await exec(
      'git',
      ['fetch', '--no-tags', '--no-recurse-submodules', source, input.head],
      options,
    )
    const commit = await exec('git', ['rev-parse', 'FETCH_HEAD^{commit}'], options)
    if (commit.stdout.trim() !== input.head) throw Error('提交不是已审版本。')
    input.signal.throwIfAborted()
    input.beforeWrite()
    await exec(
      'git',
      [
        '--config-env=http.https://github.com/.extraHeader=ZERO_BRANCH_AUTHORIZATION',
        '-c',
        'http.followRedirects=false',
        'push',
        '--porcelain',
        `https://github.com/${input.repository}.git`,
        `${input.head}:refs/heads/${input.branch}`,
      ],
      {
        ...options,
        env: {
          ...env,
          ZERO_BRANCH_AUTHORIZATION:
            'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64'),
        },
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function publishGithubAppBranch(
  auth: GithubAppMergeAuth,
  input: BranchInput,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
  push: typeof pushCommit = pushCommit,
) {
  const { repository, branch, head, signal } = input
  if (
    !/^[a-z0-9-]+\/[a-z0-9._-]+$/iu.test(repository) ||
    /\/\.{1,2}$/u.test(repository) ||
    !/^[a-f0-9]{40}$/u.test(head) ||
    !branch ||
    branch.startsWith('-')
  )
    throw Error('请提供已绑定的仓库、分支和完整提交号。')
  await exec('git', ['check-ref-format', 'refs/heads/' + branch], { signal }).catch(() => {
    throw Error('PR 分支名称无效。')
  })
  const { token, botLogin } = await auth.getMergeAccess(input.ref, repository, signal)
  const options = {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ZeRo-OS-Trigger',
    },
    redirect: 'manual' as const,
    signal,
  }
  const base = 'https://api.github.com/repos/' + repository
  const repo = await fetcher(base, options)
  if (!repo.ok) throw Error(`无法核对目标仓库（HTTP ${repo.status}）。`)
  const metadata = await repo.json()
  if (metadata.full_name?.toLowerCase() !== repository.toLowerCase() || !metadata.default_branch)
    throw Error('GitHub 返回的仓库与当前绑定不一致。')
  if (branch === metadata.default_branch)
    throw Error('请选择用于开 PR 的分支；默认分支通过 PR 合并。')
  const encoded = branch.split('/').map(encodeURIComponent).join('/')
  const url = 'https://github.com/' + repository + '/tree/' + encoded
  async function remoteHead() {
    const response = await fetcher(base + '/git/ref/heads/' + encoded, options)
    if (response.status === 404) return null
    if (!response.ok) throw Error(`无法核对远端分支（HTTP ${response.status}）。`)
    const ref = await response.json()
    if (
      ref.ref !== 'refs/heads/' + branch ||
      ref.object?.type !== 'commit' ||
      !/^[a-f0-9]{40}$/u.test(ref.object?.sha)
    )
      throw Error('GitHub 的分支回执无效。')
    return ref.object.sha as string
  }
  const receipt = { repository, branch, head, url, app: botLogin }
  if ((await remoteHead()) === head) return { ...receipt, status: 'existing' as const }
  signal.throwIfAborted()
  input.beforeWrite()
  let errorMessage: string | undefined
  try {
    await push(input, token)
  } catch (error) {
    // Git errors can include request headers. Expose only the diagnosis, never raw output.
    const message = error instanceof Error ? error.message : ''
    errorMessage = /non-fast-forward|fetch first|failed to lock|cannot lock ref/i.test(message)
      ? '远端分支已变化，请读取新提交后再办理。'
      : /not our ref|unadvertised object|couldn.t find remote ref|invalid path|does not appear to be a git repository|ENOENT/i.test(
            message,
          )
        ? '本地仓库或提交包中找不到已审提交。'
        : /permission|denied|protected|repository rule|forbidden|403/i.test(message)
          ? 'GitHub 拒绝写入，请核对 App 安装权限和目标分支规则。'
          : '分支未确认发布，请核对本地提交、分支名称及 App 写权限。'
  }
  const actual = await remoteHead().catch(() => {
    throw Error(`分支结果待核对，请先查看 ${url} 的提交。`)
  })
  if (actual !== head) throw Error(errorMessage ?? `远端分支尚未指向已审提交，请核对 ${url}。`)
  return { ...receipt, status: 'published' as const }
}
