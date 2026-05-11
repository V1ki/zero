import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@zero-os/shared'
import {
  SourceCardManager,
  SourceCardService,
  createQqMailHimalayaSourceCard,
} from '../../source-card'
import { SourceCardTool } from '../source-card'

const tempDirs: string[] = []

function createTool(): {
  manager: SourceCardManager
  tool: SourceCardTool
  ctx: ToolContext
} {
  const dir = mkdtempSync(join(tmpdir(), 'zero-source-card-tool-'))
  tempDirs.push(dir)
  const manager = new SourceCardManager(dir)
  const service = new SourceCardService(manager)
  const tool = new SourceCardTool(service)
  const ctx = {
    sessionId: 'test-session',
    workDir: dir,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as ToolContext
  return { manager, tool, ctx }
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
    manager.create(createQqMailHimalayaSourceCard())

    const listResult = await tool.run(ctx, { action: 'list' })
    const validateResult = await tool.run(ctx, {
      action: 'validate',
      sourceCardId: 'qq-mail-himalaya',
    })

    expect(listResult.success).toBe(true)
    expect(listResult.output).toContain('qq-mail-himalaya')
    expect(listResult.output).not.toContain('external:himalaya/account/qq')
    expect(listResult.output).not.toContain('secret-token')
    expect(validateResult.output).toContain('"ok": true')
  })

  test('promotes and retires only through explicit management actions', async () => {
    const { manager, tool, ctx } = createTool()
    manager.create(createQqMailHimalayaSourceCard())
    manager.transitionState('qq-mail-himalaya', 'verified', 'verified in test')

    const promote = await tool.run(ctx, {
      action: 'promote',
      sourceCardId: 'qq-mail-himalaya',
      reason: 'approved metadata-only use',
      reviewedCapabilityIds: ['list_envelopes'],
      privateScopeConfirmation: {
        metadataOnly: true,
        bodyAccessApproved: false,
        attachmentAccessApproved: false,
      },
    })
    const retire = await tool.run(ctx, {
      action: 'retire',
      sourceCardId: 'qq-mail-himalaya',
      reason: 'user disabled source',
    })

    expect(promote.success).toBe(true)
    expect(promote.output).toContain('"state": "active"')
    expect(retire.success).toBe(true)
    expect(retire.output).toContain('"state": "retired"')
  })

  test('does not expose health recording or source execution actions', async () => {
    const { manager, tool, ctx } = createTool()
    manager.create(createQqMailHimalayaSourceCard())

    const result = await tool.run(ctx, {
      action: 'recordHealthResult',
      sourceCardId: 'qq-mail-himalaya',
    })

    expect(result.success).toBe(false)
    expect(result.output).toContain('Unsupported source_card action')
  })
})
