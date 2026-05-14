import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceCard, ToolContext } from '@zero-os/shared'
import { SessionSourceMiner, SourceCardManager, SourceCardService } from '../../source-card'
import type { SessionSourceMinerReader } from '../../source-card'
import { SourceCardTool } from '../source-card'

const tempDirs: string[] = []

function createTool(reader: SessionSourceMinerReader = createMinerReader()): {
  manager: SourceCardManager
  tool: SourceCardTool
  minerTool: SourceCardTool
  ctx: ToolContext
} {
  const dir = mkdtempSync(join(tmpdir(), 'zero-source-card-tool-'))
  tempDirs.push(dir)
  const manager = new SourceCardManager(dir)
  const service = new SourceCardService(manager)
  const tool = new SourceCardTool(service)
  const miner = new SessionSourceMiner({
    reader,
    listSourceCards: () => service.list(),
  })
  const minerTool = new SourceCardTool(service, miner)
  const ctx = {
    sessionId: 'test-session',
    workDir: dir,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as ToolContext
  return { manager, tool, minerTool, ctx }
}

function createCard(overrides: Partial<SourceCard> = {}): SourceCard {
  return {
    schemaVersion: 1,
    id: 'market-doc',
    title: 'Market data doc',
    state: 'draft',
    sensitivity: 'public',
    tags: ['market-data'],
    sourceDoc: {
      format: 'markdown',
      body: '# Market data doc\n\n## When to use\n- Use for public stock quotes.\n\n## How to use\n- Fetch https://push2.eastmoney.com/api/qt/stock/get.',
    },
    ...overrides,
  }
}

function createMinerReader(): SessionSourceMinerReader {
  return {
    readSession: (sessionId) => ({ id: sessionId, source: 'web' }),
    readMessages: (sessionId) => [
      {
        id: 'msg_market',
        sessionId,
        role: 'assistant',
        messageType: 'message',
        createdAt: '2026-05-12T00:00:00.000Z',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tool_market',
            outputSummary: 'Eastmoney quote metadata',
            content:
              'fetch https://push2.eastmoney.com/api/qt/stock/get statusCode 200 schemaKeys data diff f43 f57 f58',
          },
        ],
      },
    ],
    readTraceEntries: () => [],
    readRunLog: () => [],
    readArtifacts: () => [],
  }
}

function createPrivateMinerReader(): SessionSourceMinerReader {
  return {
    readSession: (sessionId) => ({ id: sessionId, source: 'web' }),
    readMessages: (sessionId) => [
      {
        id: 'msg_private_mail',
        sessionId,
        role: 'assistant',
        messageType: 'message',
        createdAt: '2026-05-12T00:00:00.000Z',
        content: [
          {
            type: 'tool_use',
            id: 'tool_mail',
            name: 'bash',
            input: {
              command: 'himalaya envelope list --folder INBOX',
              credentialRef: 'external:himalaya/account/qq',
            },
          },
          {
            type: 'tool_result',
            toolUseId: 'tool_mail',
            outputSummary: 'QQ Mail envelope metadata',
            content:
              'himalaya envelope metadata mailBody 邮箱正文示例 attachmentText 附件内容 rawPayload 原始私密 payload authorization=Bearer private-token',
          },
        ],
      },
    ],
    readTraceEntries: () => [],
    readRunLog: () => [],
    readArtifacts: () => [],
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('SourceCardTool', () => {
  test('lists and validates Source Cards without exposing credential refs', async () => {
    const { manager, tool, ctx } = createTool()
    manager.create(createCard())
    manager.create(
      createCard({
        id: 'mail-doc',
        title: 'Mail metadata doc',
        sensitivity: 'private',
        tags: ['mail', 'himalaya'],
        sourceDoc: {
          format: 'markdown',
          body: '# Mail metadata doc\n\n## How to use\n- Use himalaya metadata commands only.',
        },
      }),
    )

    const listResult = await tool.run(ctx, { action: 'list' })
    const getResult = await tool.run(ctx, {
      action: 'get',
      sourceCardId: 'market-doc',
    })
    const validateResult = await tool.run(ctx, {
      action: 'validate',
      sourceCardId: 'mail-doc',
    })

    expect(listResult.success).toBe(true)
    expect(listResult.output).toContain('mail-doc')
    expect(getResult.output).toContain('"sourceDoc"')
    expect(getResult.output).toContain('push2.eastmoney.com/api/qt/stock/get')
    expect(listResult.output).not.toContain('external:himalaya/account/qq')
    expect(listResult.output).not.toContain('secret-token')
    expect(validateResult.output).toContain('"ok": true')
  })

  test('activates and retires only through explicit management actions', async () => {
    const { manager, tool, ctx } = createTool()
    manager.create(createCard())

    const activate = await tool.run(ctx, {
      action: 'activate',
      sourceCardId: 'market-doc',
      reason: 'approved document',
    })
    const retire = await tool.run(ctx, {
      action: 'retire',
      sourceCardId: 'market-doc',
      reason: 'user disabled source',
    })

    expect(activate.success).toBe(true)
    expect(activate.output).toContain('"state": "active"')
    expect(retire.success).toBe(true)
    expect(retire.output).toContain('"state": "retired"')
  })

  test('does not expose health recording, promotion, or source execution actions', async () => {
    const { manager, tool, ctx } = createTool()
    manager.create(createCard())

    const recordHealth = await tool.run(ctx, {
      action: 'recordHealthResult',
      sourceCardId: 'market-doc',
    })
    const promote = await tool.run(ctx, {
      action: 'promote',
      sourceCardId: 'market-doc',
    })

    expect(recordHealth.success).toBe(false)
    expect(recordHealth.output).toContain('Unsupported source_card action')
    expect(promote.success).toBe(false)
    expect(promote.output).toContain('Unsupported source_card action')
  })

  test('generates, validates, and creates document drafts through explicit actions', async () => {
    const { manager, minerTool, ctx } = createTool()

    const generated = await minerTool.run(ctx, {
      action: 'generate_draft',
      useCurrentSession: true,
    })
    expect(generated.success).toBe(true)

    const draft = JSON.parse(generated.output)
    expect(draft.sourceSessionId).toBe(ctx.sessionId)
    expect(draft.proposedCard.state).toBe('draft')
    expect(draft.proposedCard.title).toBe('A-share market data')
    expect(draft.proposedCard.sourceDoc.body).toContain('## How to use')

    const validation = await minerTool.run(ctx, {
      action: 'validate_draft',
      draft,
    })
    expect(validation.output).toContain('"ok": true')

    const rejected = await minerTool.run(ctx, {
      action: 'create_from_draft',
      draft,
      confirm: false,
    })
    expect(rejected.success).toBe(false)
    expect(rejected.output).toContain('confirm=true')

    const created = await minerTool.run(ctx, {
      action: 'create_from_draft',
      draft,
      confirm: true,
    })
    expect(created.success).toBe(true)
    expect(created.output).toContain('"state": "draft"')
    expect(created.output).not.toContain('"state": "active"')
    expect(manager.get(draft.proposedCard.id)?.state).toBe('draft')
  })

  test('create_from_draft recomputes dedupe and private summaries stay metadata-only', async () => {
    const { manager, minerTool, ctx } = createTool(createPrivateMinerReader())
    manager.create(
      createCard({
        id: 'qq-mail-source',
        title: 'QQ Mail source',
        sensitivity: 'private',
        tags: ['mail', 'qq-mail', 'himalaya'],
      }),
    )

    const generated = await minerTool.run(ctx, {
      action: 'generate_draft',
      useCurrentSession: true,
    })
    expect(generated.success).toBe(true)
    const draft = JSON.parse(generated.output)
    const summaryText = JSON.stringify(draft.evidenceRefs)

    expect(summaryText).toContain('metadata-only summary')
    expect(summaryText).toContain('cli:himalaya')
    expect(summaryText).not.toContain('邮箱正文示例')
    expect(summaryText).not.toContain('附件内容')
    expect(summaryText).not.toContain('原始私密 payload')
    expect(summaryText).not.toMatch(/authorization|token|credentialRef|external:himalaya/i)

    const tampered = { ...draft, dedupeCandidates: [] }
    const rejected = await minerTool.run(ctx, {
      action: 'create_from_draft',
      draft: tampered,
      confirm: true,
    })
    expect(rejected.success).toBe(false)
    expect(rejected.output).toContain('dedupeDecision')

    const append = await minerTool.run(ctx, {
      action: 'create_from_draft',
      draft: tampered,
      confirm: true,
      dedupeDecision: 'append_evidence',
    })
    expect(append.success).toBe(false)
    expect(append.output).toContain('not implemented')
  })
})
