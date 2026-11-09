import { createHash } from 'node:crypto'
import type { RouterLedgerStore } from '@zero-os/observe'
import { TriggerAgentError } from './event-agent'
import type { createMandatePlatforms } from './mandate-platforms'
import { capability, routerInteger, routerText } from './router-capabilities'

type Transport = Pick<ReturnType<typeof createMandatePlatforms>, 'appendDocument' | 'probeArchive'>
export class RouterDocuments {
  constructor(
    private readonly ledger: RouterLedgerStore,
    private readonly transport: Transport,
  ) {}
  list(principal: string) {
    return this.ledger.documents(principal)
  }
  async configure(
    principal: string,
    input: { id: string; channelId: string; documentId: string; label: string; url: string },
  ) {
    if (
      principal !== 'router-owner' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id) ||
      !/^[a-zA-Z0-9]{1,128}$/.test(input.documentId)
    )
      throw new TriggerAgentError('归档目标无效。')
    const url = new URL(input.url)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !/^(?:[a-z0-9-]+\.)*(?:feishu\.cn|larksuite\.com)$/.test(url.hostname) ||
      url.pathname !== `/docx/${input.documentId}`
    )
      throw new TriggerAgentError('文档链接必须指向这个飞书文档。')
    const access = await this.transport.probeArchive({
      channelId: input.channelId,
      documentId: input.documentId,
    })
    if (!access.ok) throw new TriggerAgentError(access.reason)
    return this.ledger.configureDocument({ ...input, principal })
  }
  capabilities(
    principal: string,
    turnId: number,
    authorized: () => boolean,
    mayRead: (matterId: string) => boolean = () => true,
  ) {
    const guard = () => {
      if (!authorized() || principal !== 'router-owner')
        throw new TriggerAgentError('归档授权已变更。')
    }
    const text = { type: 'string', minLength: 1 }
    return [
      capability(
        'list_archive_documents',
        '读取用户已配置且授权的文档目标。归档独立于通知，不把通知失败当成归档失败。',
        {},
        () => {
          guard()
          return this.list(principal)
        },
      ),
      capability(
        'archive_document',
        '把需保存的完整结果写入已授权文档，保留证据和限制，不只复制通知摘要。每次操作先保存执行记录；未知结果不可自动重发。',
        {
          matterId: text,
          version: { type: 'integer', minimum: 1 },
          targetId: text,
          title: text,
          body: text,
        },
        async (args, signal) => {
          guard()
          const matterId = routerText(args.matterId, 100)
          const version = routerInteger(args.version)
          const targetId = routerText(args.targetId, 80)
          const title = routerText(args.title, 200)
          const body = routerText(args.body, null)
          const target = this.list(principal).find((t) => t.id === targetId)
          if (
            !target ||
            !mayRead(matterId) ||
            this.ledger.getMatter(principal, matterId)?.version !== version
          )
            throw new TriggerAgentError('归档目标或事项版本无效。')
          const key = createHash('sha256')
            .update(
              JSON.stringify([
                principal,
                turnId,
                matterId,
                version,
                target.id,
                target.version,
                title,
                body,
              ]),
            )
            .digest('hex')
          const claimed = this.ledger.operations.claim({
            key,
            principal,
            kind: 'archive-document',
            resource: target.id,
            request: { matterId, version, targetVersion: target.version, title, body },
          })
          if (!claimed.claimed) return claimed.operation
          const current = () =>
            authorized() &&
            mayRead(matterId) &&
            this.list(principal).find((t) => t.id === targetId)?.version === target.version &&
            this.ledger.getMatter(principal, matterId)?.version === version
          try {
            const result = await this.transport.appendDocument(
              target,
              key,
              title,
              body,
              signal,
              current,
            )
            this.ledger.operations.finish(principal, key, result.status, result)
            return { ...result, url: target.url, operationId: key }
          } catch (error) {
            this.ledger.operations.finish(principal, key, 'unknown', {
              reason: '文档写入未返回完整回执，需核对文档后再继续。',
            })
            throw error
          }
        },
      ),
    ]
  }
}
