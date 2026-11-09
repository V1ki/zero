import type { TriggerInboxItem, TriggerSettingsSnapshot } from '@zero-os/shared'
import type { GithubAppCommentAuth } from './github-app-auth'
import { githubReplySubject } from './router-github-reply'

type Fetch = (url: URL, init: RequestInit) => Promise<Response>
export interface GithubIssueCloseGuard {
  current(): boolean
  verify?(signal: AbortSignal): Promise<boolean>
  /** Pin the precise issue revision reviewed by an automatic policy, if applicable. */
  expectedIssueId?: number
  expectedUpdatedAt?: string
  duplicateOf?: { id: number; number: number }
}
export interface GithubIssueCloseReceipt {
  state: 'closed' | 'already_closed'
  repository: string
  number: number
  issueId: number
  url: string
}

export class GithubIssueCloseUncertainError extends Error {
  constructor() {
    super('已尝试关闭 Issue，但未能确认它的最终状态。请先核对原讨论，系统不会自动重试关闭。')
  }
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const positive = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0
const denied = () => new Error('当前事件的 Issue 关闭授权或仓库绑定已变更，未执行关闭。')
const mismatched = () => new Error('无法核对 GitHub Issue 的仓库、编号或身份，未执行关闭。')
const changed = () => new Error('GitHub Issue 与先前核验的版本不符，未执行关闭。')

/** No free-form destination: the issue number, repository ID and App are pinned by the stored event.
 * One invocation sends at most one PATCH. A missing response is reconciled by reading, never by replay. */
export function createGithubIssueCloser(
  settings: () => TriggerSettingsSnapshot,
  auth: GithubAppCommentAuth,
  fetcher: Fetch = fetch,
) {
  return async (
    event: TriggerInboxItem,
    signal: AbortSignal,
    guard: GithubIssueCloseGuard,
  ): Promise<GithubIssueCloseReceipt> => {
    const binding = () => githubReplySubject(event, settings().settings.github.repositories)
    const target = binding()
    if (!target || target.kind !== 'issue' || !positive(target.repositoryId) || !guard.current())
      throw denied()
    if (
      (guard.expectedIssueId !== undefined && !positive(guard.expectedIssueId)) ||
      (guard.expectedUpdatedAt !== undefined &&
        !Number.isFinite(Date.parse(guard.expectedUpdatedAt)))
    )
      throw changed()
    const { repository, number, ref, repositoryId, url } = target
    const duplicate = guard.duplicateOf
    if (
      duplicate &&
      (!positive(duplicate.number) ||
        !positive(duplicate.id) ||
        duplicate.number === number ||
        duplicate.id === guard.expectedIssueId ||
        guard.expectedIssueId === undefined ||
        guard.expectedUpdatedAt === undefined ||
        !guard.verify)
    )
      throw changed()
    const check = () => {
      signal.throwIfAborted()
      const now = binding()
      if (
        !guard.current() ||
        !now ||
        now.kind !== 'issue' ||
        now.repositoryId !== repositoryId ||
        now.url !== url ||
        now.ref !== ref
      )
        throw denied()
    }
    check()
    const { token } = await auth.getCommentAccess(ref, repository, signal)
    check()
    const base = new URL(`https://api.github.com/repos/${repository}`)
    const item = new URL(`${base.href}/issues/${number}`)
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ZeRo-OS-Issue-Worker',
    }
    const call = (endpoint: URL, init: RequestInit) =>
      fetcher(endpoint, {
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        ...init,
      })
    async function get(endpoint: URL) {
      check()
      const response = await call(endpoint, { method: 'GET', headers }).catch(() => {
        throw new Error('无法连接 GitHub 核对 Issue 状态。')
      })
      if (response.status !== 200) {
        await response.body?.cancel()
        throw new Error(`GitHub 未能提供 Issue 核验记录（HTTP ${response.status}）。`)
      }
      const row: unknown = await response.json().catch(() => {
        throw mismatched()
      })
      if (!object(row)) throw mismatched()
      return { row, etag: response.headers.get('ETag') }
    }
    const validIssue = (row: Record<string, unknown>, issueNumber = number) =>
      positive(row.id) &&
      row.number === issueNumber &&
      row.pull_request === undefined &&
      same(row.url, `${base.href}/issues/${issueNumber}`) &&
      same(row.repository_url, base.href) &&
      same(row.html_url, `https://github.com/${repository}/issues/${issueNumber}`) &&
      (row.state === 'open' || row.state === 'closed')
    const [repo, initial] = await Promise.all([get(base), get(item)])
    check()
    if (
      repo.row.id !== repositoryId ||
      !same(repo.row.full_name, repository) ||
      !validIssue(initial.row) ||
      !positive(initial.row.id)
    )
      throw mismatched()
    const issueId = initial.row.id
    const receipt = (state: GithubIssueCloseReceipt['state']): GithubIssueCloseReceipt => ({
      state,
      repository,
      number,
      issueId,
      url,
    })
    if (guard.expectedIssueId !== undefined && issueId !== guard.expectedIssueId) throw changed()
    if (guard.verify && !(await guard.verify(signal))) throw denied()
    check()
    // Some REST responses omit the canonical id. Only an acknowledged PATCH can stand in for it.
    const matchesClosure = (row: Record<string, unknown>, acknowledged: boolean) =>
      row.state === 'closed' &&
      (!duplicate ||
        (row.state_reason === 'duplicate' &&
          (row.duplicate_issue_id === duplicate.id ||
            (acknowledged && row.duplicate_issue_id === undefined))))
    const alreadyClosed = (row: Record<string, unknown>) => {
      if (!matchesClosure(row, false)) throw changed()
      return receipt('already_closed')
    }
    if (initial.row.state === 'closed') return alreadyClosed(initial.row)
    if (duplicate) {
      const { row } = await get(new URL(`${base.href}/issues/${duplicate.number}`))
      if (
        !validIssue(row, duplicate.number) ||
        row.id !== duplicate.id ||
        row.state !== 'closed' ||
        row.state_reason !== 'completed'
      )
        throw changed()
    }
    let etag = initial.etag
    if (guard.expectedUpdatedAt !== undefined) {
      if (initial.row.updated_at !== guard.expectedUpdatedAt) throw changed()
      const latest = await get(item)
      if (!validIssue(latest.row) || latest.row.id !== issueId) throw changed()
      if (latest.row.state === 'closed') return alreadyClosed(latest.row)
      if (latest.row.updated_at !== guard.expectedUpdatedAt) throw changed()
      etag = latest.etag
    }
    check()
    let response: Response | undefined
    try {
      response = await call(item, {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          ...(etag && !etag.startsWith('W/') ? { 'If-Match': etag } : {}),
        },
        body: JSON.stringify({
          state: 'closed',
          ...(duplicate && { state_reason: 'duplicate', duplicate_issue_id: duplicate.id }),
        }),
      })
    } catch {
      // The request may already have been applied. Perform only the readback below.
    }
    if (response) {
      await response.body?.cancel().catch(() => {})
      if (response.status >= 400 && response.status < 500 && response.status !== 408)
        throw new Error(`GitHub 已拒绝关闭 Issue（HTTP ${response.status}）。`)
    }
    // A verified read from the exact original object is stronger than assuming the PATCH succeeded.
    try {
      const final = await get(item)
      if (
        validIssue(final.row) &&
        final.row.id === issueId &&
        matchesClosure(final.row, response?.status === 200)
      )
        return receipt('closed')
    } catch {
      // A revoked grant or failed read after PATCH cannot prove that no write happened.
    }
    throw new GithubIssueCloseUncertainError()
  }
}
