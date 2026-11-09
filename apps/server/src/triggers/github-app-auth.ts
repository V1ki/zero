import { createHash, createPrivateKey, sign } from 'node:crypto'
import { join } from 'node:path'
import { type Vault, loadVault } from '@zero-os/secrets'
import { triggerGithubAppRefPattern } from '@zero-os/shared'

type Fetch = (url: URL, init: RequestInit) => Promise<Response>
type AppCredential = { appId: number; privateKey: string; repository: string; slug: string }
type Token = { value: string; expiresAt: number }
type CacheEntry = { fingerprint: string; token?: Token; pending?: Promise<Token> }
const profiles = {
  listener: { metadata: 'read', issues: 'read', pull_requests: 'read' },
  comment: { metadata: 'read', issues: 'write' },
  openPull: { metadata: 'read', pull_requests: 'write' },
  merge: { metadata: 'read', pull_requests: 'read', contents: 'write' },
} as const
type Profile = keyof typeof profiles

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function credential(raw: string, repository: string): AppCredential {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('GitHub App 连接格式无效。')
  }
  if (
    !record(data) ||
    typeof data.appId !== 'number' ||
    !Number.isSafeInteger(data.appId) ||
    data.appId <= 0 ||
    typeof data.privateKey !== 'string' ||
    typeof data.slug !== 'string' ||
    !/^[a-z0-9][a-z0-9-]*$/.test(data.slug) ||
    typeof data.repository !== 'string' ||
    !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(repository) ||
    /\/\.{1,2}$/.test(repository) ||
    data.repository.toLowerCase() !== repository.toLowerCase()
  )
    throw new Error('GitHub App 连接无效或未授权该仓库。')
  return {
    appId: data.appId,
    privateKey: data.privateKey,
    slug: data.slug,
    repository: data.repository,
  }
}

function jwt(app: AppCredential, now: number): string {
  const issued = Math.floor(now / 1000)
  const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const unsigned = [
    encode({ typ: 'JWT', alg: 'RS256' }),
    encode({ iss: String(app.appId), iat: issued - 60, exp: issued + 9 * 60 }),
  ].join('.')
  try {
    const key = createPrivateKey(app.privateKey)
    if (key.asymmetricKeyType !== 'rsa') throw new Error('Expected RSA key')
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`
  } catch {
    throw new Error('无法使用 GitHub App 私钥签名。')
  }
}

async function installation(app: AppCredential, fetcher: Fetch, now: () => number) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ZeRo-OS-Trigger',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${jwt(app, now())}`,
    'Content-Type': 'application/json',
  }
  const signal = AbortSignal.timeout(20_000)
  async function request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    // No redirects: the JWT must only reach these two fixed GitHub API endpoints.
    const response = await fetcher(new URL(path, 'https://api.github.com'), {
      ...init,
      headers,
      redirect: 'manual',
      signal,
    }).catch(() => {
      throw new Error('无法连接 GitHub App 身份验证接口。')
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`GitHub App 身份校验失败（HTTP ${response.status}）。`)
    }
    let data: unknown
    try {
      data = await response.json()
    } catch {
      // A malformed response may contain a partial access token; do not surface parser errors.
      throw new Error('GitHub App 接口返回了无效的数据。')
    }
    if (!record(data)) throw new Error('GitHub App 接口返回了无效的数据。')
    return data
  }

  const [owner] = app.repository.split('/')
  const installation = await request(`/repos/${app.repository}/installation`, { method: 'GET' })
  if (
    installation.app_id !== app.appId ||
    installation.app_slug !== app.slug ||
    typeof installation.id !== 'number' ||
    !Number.isSafeInteger(installation.id) ||
    installation.id <= 0 ||
    installation.suspended_at != null ||
    !record(installation.account) ||
    typeof installation.account.login !== 'string' ||
    installation.account.login.toLowerCase() !== owner.toLowerCase()
  )
    throw new Error('GitHub App 安装与指定的仓库或应用不匹配。')
  return { installation, request }
}

async function mint(
  app: AppCredential,
  profile: Profile,
  fetcher: Fetch,
  now: () => number,
): Promise<Token> {
  const { installation: installed, request } = await installation(app, fetcher, now)
  // PR discussion comments share the Issues endpoint, but need the installation's
  // Pull requests write permission in the token as well.
  const permissions: Readonly<Record<string, string>> =
    profile === 'comment' &&
    record(installed.permissions) &&
    installed.permissions.pull_requests === 'write'
      ? { ...profiles.comment, pull_requests: 'write' }
      : profiles[profile]
  const name = app.repository.split('/')[1]
  if (
    profile === 'merge' &&
    record(installed.permissions) &&
    installed.permissions.contents !== 'write'
  )
    throw new Error('当前 GitHub App 安装缺少 Contents 写权限，无法合并 PR。')
  if (
    profile === 'openPull' &&
    record(installed.permissions) &&
    installed.permissions.pull_requests !== 'write'
  )
    throw new Error(
      '当前安装缺少 Pull requests 写权限。请为绑定的 GitHub App 开启该权限，并在仓库安装中接受。',
    )
  const token = await request(`/app/installations/${installed.id}/access_tokens`, {
    method: 'POST',
    body: JSON.stringify({ repositories: [name], permissions }),
  })
  const granted = token.permissions
  const expiresAt = typeof token.expires_at === 'string' ? Date.parse(token.expires_at) : Number.NaN
  if (
    typeof token.token !== 'string' ||
    !token.token ||
    /\s/.test(token.token) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now() ||
    (token.repository_selection !== undefined && token.repository_selection !== 'selected') ||
    !record(granted) ||
    Object.entries(permissions).some(
      ([key, value]) => key !== 'metadata' && granted[key] !== value,
    ) ||
    Object.entries(granted).some(
      ([key, value]) => !Object.hasOwn(permissions, key) || permissions[key] !== value,
    ) ||
    (token.repositories !== undefined &&
      (!Array.isArray(token.repositories) ||
        token.repositories.length !== 1 ||
        typeof token.repositories[0]?.full_name !== 'string' ||
        token.repositories[0].full_name.toLowerCase() !== app.repository.toLowerCase()))
  )
    throw new Error('GitHub App 令牌过期、权限或仓库范围不匹配。')
  return { value: token.token, expiresAt }
}

export interface GithubAppAuth {
  getToken(ref: string, repository: string, signal: AbortSignal): Promise<string>
  getCommentIdentity?(ref: string, repository: string, signal: AbortSignal): Promise<string>
}

export interface GithubAppCommentAuth {
  getCommentAccess(
    ref: string,
    repository: string,
    signal: AbortSignal,
  ): Promise<{ token: string; botLogin: string }>
}

export interface GithubAppMergeAuth {
  getMergeAccess(
    ref: string,
    repository: string,
    signal: AbortSignal,
  ): Promise<{ token: string; botLogin: string }>
}
export interface GithubAppPullAuth {
  getPullAccess(
    ref: string,
    repository: string,
    signal: AbortSignal,
  ): Promise<{ token: string; botLogin: string }>
}
type GithubAppConnection = GithubAppPullAuth &
  GithubAppMergeAuth &
  GithubAppAuth &
  GithubAppCommentAuth & {
    getCommentIdentity(ref: string, repository: string, signal: AbortSignal): Promise<string>
    inspectInstallation(
      ref: string,
      repository: string,
      signal: AbortSignal,
    ): Promise<{
      repository: string
      author: string
      pullRequestsAllowed: boolean
      commentsAllowed: boolean
      mergeAllowed: boolean
    }>
  }

export const unavailableGithubAppAuth: GithubAppAuth = {
  async getToken() {
    throw new Error('GitHub App 专用凭据库未连接。')
  },
}

/** Expose only installation tokens. General HTTP tools and provider references read a separate vault. */
export function createVaultGithubAppAuth(
  zeroDir: string,
  openVault: (path: string) => Promise<Pick<Vault, 'get'>> = loadVault,
): GithubAppConnection {
  const path = join(zeroDir, 'github-app', 'credentials.enc')
  let provider: Promise<GithubAppConnection> | undefined
  function load(signal: AbortSignal) {
    signal.throwIfAborted()
    provider ??= openVault(path)
      .then((vault) => createGithubAppAuth((key) => vault.get(key)))
      .catch(() => {
        provider = undefined
        throw new Error('无法打开 GitHub App 专用凭据库。')
      })
    return provider
  }
  return {
    async getToken(ref, repository, signal) {
      return (await load(signal)).getToken(ref, repository, signal)
    },
    async getPullAccess(ref, repository, signal) {
      return (await load(signal)).getPullAccess(ref, repository, signal)
    },
    async getMergeAccess(ref, repository, signal) {
      return (await load(signal)).getMergeAccess(ref, repository, signal)
    },
    async inspectInstallation(ref, repository, signal) {
      return (await load(signal)).inspectInstallation(ref, repository, signal)
    },
    async getCommentAccess(ref, repository, signal) {
      return (await load(signal)).getCommentAccess(ref, repository, signal)
    },
    async getCommentIdentity(ref, repository, signal) {
      return (await load(signal)).getCommentIdentity(ref, repository, signal)
    },
  }
}

export function createGithubAppAuth(
  resolveSecret: (ref: string) => string | undefined,
  { fetcher = fetch, now = Date.now }: { fetcher?: Fetch; now?: () => number } = {},
): GithubAppConnection {
  const caches = {
    listener: new Map<string, CacheEntry>(),
    comment: new Map<string, CacheEntry>(),
    merge: new Map<string, CacheEntry>(),
    openPull: new Map<string, CacheEntry>(),
  }
  function boundCredential(ref: string, repository: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!triggerGithubAppRefPattern.test(ref)) throw new Error('无效的 GitHub App 凭据引用。')
    const raw = resolveSecret(ref)
    if (!raw) {
      caches.listener.delete(ref)
      caches.comment.delete(ref)
      caches.merge.delete(ref)
      caches.openPull.delete(ref)
      throw new Error('找不到 GitHub App 凭据。')
    }
    return { app: credential(raw, repository), raw }
  }
  async function access(profile: Profile, ref: string, repository: string, signal: AbortSignal) {
    const cache = caches[profile]
    const { app, raw } = boundCredential(ref, repository, signal)
    const fingerprint = createHash('sha256').update(raw).digest('hex')
    let entry = cache.get(ref)
    if (!entry || entry.fingerprint !== fingerprint) {
      entry = { fingerprint }
      cache.set(ref, entry)
    }
    const botLogin = `${app.slug}[bot]`
    if (entry.token && entry.token.expiresAt > now() + 5 * 60_000)
      return { token: entry.token.value, botLogin }
    const current = entry
    current.pending ??= mint(app, profile, fetcher, now)
      .then((token) => {
        current.token = token
        return token
      })
      .finally(() => {
        current.pending = undefined
      })
    // Each caller can stop waiting. Concurrent users share the bounded exchange.
    let cancel: (() => void) | undefined
    try {
      const token = await Promise.race([
        current.pending,
        new Promise<never>((_, reject) => {
          cancel = () => reject(signal.reason)
          signal.addEventListener('abort', cancel, { once: true })
          if (signal.aborted) cancel()
        }),
      ])
      signal.throwIfAborted()
      if (resolveSecret(ref) !== raw) throw new Error('GitHub App 凭据已更换。')
      return { token: token.value, botLogin }
    } finally {
      if (cancel) signal.removeEventListener('abort', cancel)
    }
  }
  return {
    async getToken(ref, repository, signal) {
      return (await access('listener', ref, repository, signal)).token
    },
    getPullAccess(ref, repository, signal) {
      return access('openPull', ref, repository, signal)
    },
    getMergeAccess(ref, repository, signal) {
      return access('merge', ref, repository, signal)
    },
    async inspectInstallation(ref, repository, signal) {
      const { app, raw } = boundCredential(ref, repository, signal)
      const { installation: installed } = await installation(app, fetcher, now)
      signal.throwIfAborted()
      if (resolveSecret(ref) !== raw) throw new Error('GitHub App 凭据已更换。')
      if (!record(installed.permissions)) throw new Error('无法核对安装的仓库权限。')
      return {
        repository: app.repository,
        author: `${app.slug}[bot]`,
        commentsAllowed: installed.permissions.issues === 'write',
        pullRequestsAllowed: installed.permissions.pull_requests === 'write',
        mergeAllowed:
          installed.permissions.contents === 'write' &&
          ['read', 'write'].includes(String(installed.permissions.pull_requests)),
      }
    },
    getCommentAccess(ref, repository, signal) {
      return access('comment', ref, repository, signal)
    },
    async getCommentIdentity(ref, repository, signal) {
      const { app } = boundCredential(ref, repository, signal)
      return `${app.slug}[bot]`
    },
  }
}
