import { createHash } from 'node:crypto'
import type { TriggerStore } from '@zero-os/observe'
import { githubReplySubject } from '@zero-os/shared'
import type { GithubAppCommentAuth } from './github-app-auth'
import { GithubAppCommentRejectedError, postGithubAppComment } from './github-app-comment'

export { githubReplySubject }

export class GithubReplyError extends Error {
  constructor(
    readonly httpStatus: 400 | 404 | 409 | 412 | 502 | 503,
    message: string,
    readonly unknown = false,
  ) {
    super(message)
  }
}
const unconfirmed = () =>
  new GithubReplyError(
    409,
    '这条评论的发送结果待核对，请先查看 GitHub 原讨论。为避免重复，不会再次发送相同正文。',
    true,
  )
const bindingChanged = () =>
  new GithubReplyError(412, 'GitHub 事件或机器人绑定已更改，请刷新并重新核对。')
const secretText = () => new GithubReplyError(400, '评论正文含凭据，请移除后再发送。')

export class RouterGithubReplies {
  private readonly stop = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  constructor(
    private readonly store: Pick<TriggerStore, 'getInboxItem' | 'getSettings' | 'githubReplies'>,
    private readonly auth: GithubAppCommentAuth & {
      getCommentIdentity(ref: string, repository: string, signal: AbortSignal): Promise<string>
    },
    private readonly filter: (text: string) => string,
    private readonly post = postGithubAppComment,
  ) {}

  private bound(id: number) {
    return githubReplySubject(
      this.store.getInboxItem(id),
      this.store.getSettings().settings.github.repositories,
    )
  }
  private async author(ref: string, repository: string) {
    try {
      return await this.auth.getCommentIdentity(ref, repository, this.stop.signal)
    } catch {
      throw new GithubReplyError(503, '无法读取此仓库绑定的 GitHub App 身份。')
    }
  }
  private isSecret(text: string) {
    return this.filter(text) !== text || /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u.test(text)
  }
  async preview(id: number) {
    const target = this.bound(id)
    if (!target) return { target: null }
    const { repository, number, kind, url, ref } = target
    const delivery = this.store.githubReplies.latest(id)
    return {
      target: { repository, number, kind, url, author: await this.author(ref, repository) },
      ...(delivery && { delivery }),
    }
  }
  send(id: number, requestId: string, body: unknown, expectedAuthor: string) {
    if (this.stop.signal.aborted) throw new GithubReplyError(503, 'Router 正在关闭。')
    return this.trackSend(this.publish(id, requestId, body, expectedAuthor))
  }

  async sendWork(
    id: number,
    body: string,
    ref: string,
    repository: string,
    guard: {
      current: () => boolean
      verify: (signal: AbortSignal) => Promise<boolean>
      signal: AbortSignal
    },
  ) {
    if (this.stop.signal.aborted || !guard.current()) throw bindingChanged()
    const expectedAuthor = await this.author(ref, repository)
    if (!guard.current()) throw bindingChanged()
    // One autonomous reply per inbound comment, including across restarts and model changes.
    return this.trackSend(
      this.publish(id, 'worker:original-discussion', body, expectedAuthor, guard),
    )
  }

  private trackSend<T>(work: Promise<T>) {
    this.active.add(work)
    work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    )
    return work
  }
  async close() {
    this.stop.abort()
    await Promise.allSettled(this.active)
  }
  private async publish(
    id: number,
    requestId: string,
    body: unknown,
    expectedAuthor: string,
    guard?: {
      current: () => boolean
      verify: (signal: AbortSignal) => Promise<boolean>
      signal: AbortSignal
    },
  ) {
    if (
      typeof body !== 'string' ||
      !body.trim() ||
      body.length > 4000 ||
      /\p{Cc}/u.test(body.replace(/[\r\n\t]/gu, ''))
    )
      throw new GithubReplyError(400, '请输入 1 至 4000 个字符的评论。')
    if (this.isSecret(body)) throw secretText()
    const target = this.bound(id)
    if (!target) throw new GithubReplyError(404, '此事件没有可回复的 GitHub 原讨论或已启用的 App。')
    const { ref, repository, repositoryId, number } = target
    const author = await this.author(ref, repository)
    if (expectedAuthor !== author) throw bindingChanged()
    const text = body.trim()
    const fingerprint = createHash('sha256')
      // A changed vault alias for the same bot does not make this a new comment.
      .update(JSON.stringify([repositoryId, number, author, text]))
      .digest('hex')
    const receipts = this.store.githubReplies
    const claim = receipts.claim(id, requestId, fingerprint)
    if (claim.state === 'sent')
      return { status: 'sent' as const, id: claim.id, url: claim.url, author: claim.author }
    if (claim.state === 'rejected') throw new GithubReplyError(502, claim.error)
    if (claim.state === 'conflict')
      throw new GithubReplyError(409, '此请求标识已用于其他评论，或事件已过期。')
    if (claim.state !== 'new') throw unconfirmed()

    let posting = false
    let result: Awaited<ReturnType<typeof postGithubAppComment>>
    try {
      result = await this.post(this.auth, {
        ref,
        repository,
        expectedRepositoryId: repositoryId,
        expectedAuthor: author,
        issueNumber: number,
        body: text,
        signal: AbortSignal.any([
          this.stop.signal,
          AbortSignal.timeout(60_000),
          ...(guard ? [guard.signal] : []),
        ]),
        verifyRequest: guard?.verify,
        beforePost: () => {
          const now = this.bound(id)
          if (
            !now ||
            now.ref !== ref ||
            now.url !== target.url ||
            now.repositoryId !== repositoryId
          )
            throw bindingChanged()
          if (this.isSecret(text)) throw secretText()
          if (guard && !guard.current()) throw bindingChanged()
          posting = true
        },
      })
    } catch (error) {
      if (posting && !(error instanceof GithubAppCommentRejectedError)) {
        receipts.finish(id, requestId, { state: 'unknown' })
        throw unconfirmed()
      }
      const message =
        error instanceof GithubReplyError || error instanceof GithubAppCommentRejectedError
          ? error.message
          : '评论未发布。请核对 GitHub App 的仓库授权、Issues 写权限及原讨论。'
      receipts.finish(id, requestId, { state: 'rejected', error: message })
      throw error instanceof GithubReplyError ? error : new GithubReplyError(502, message)
    }
    // If this durable write fails, leave the pending claim in place; the POST may not be repeated.
    try {
      receipts.finish(id, requestId, { state: 'sent', ...result })
    } catch {
      throw unconfirmed()
    }
    return { status: 'sent' as const, ...result }
  }
}
