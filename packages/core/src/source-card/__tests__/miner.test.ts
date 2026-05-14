import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, SourceCard } from '@zero-os/shared'
import { SessionSourceMiner, SourceCardManager, SourceCardService } from '../index'
import type { SessionSourceMinerReader } from '../miner'

const tempDirs: string[] = []

const sessionId = 'sess_20260512_1030_web_mine'

function createMessage(id: string, content: Message['content']): Message {
  return {
    id,
    sessionId,
    role: id.includes('user') ? 'user' : 'assistant',
    messageType: 'message',
    content,
    createdAt: '2026-05-12T02:30:00.000Z',
  }
}

function createExistingMailCard(): SourceCard {
  return {
    schemaVersion: 1,
    id: 'qq-mail-source',
    title: 'QQ Mail source',
    state: 'active',
    sensitivity: 'private',
    tags: ['mail', 'qq-mail', 'himalaya'],
    sourceDoc: {
      format: 'markdown',
      body: '# QQ Mail source\n\n## When to use\n- Use for QQ Mail metadata.\n\n## How to use\n- Use himalaya metadata commands only.',
    },
  }
}

function createReader(calls: string[]): SessionSourceMinerReader {
  return {
    readSession: (id) => {
      calls.push('readSession')
      return {
        id,
        source: 'web',
        createdAt: '2026-05-12T02:30:00.000Z',
        updatedAt: '2026-05-12T02:33:00.000Z',
      }
    },
    readMessages: () => {
      calls.push('readMessages')
      return [
        createMessage('msg_user_1', [
          {
            type: 'text',
            text: '请基于 himalaya CLI 的 QQ Mail envelope metadata 沉淀 Source Card。',
          },
        ]),
        createMessage('msg_assistant_1', [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'bash',
            input: {
              command: 'himalaya envelope list --account qq --folder INBOX',
              credentialRef: 'external:himalaya/account/qq',
            },
          },
          {
            type: 'tool_result',
            toolUseId: 'tool_1',
            outputSummary: 'listed envelope metadata',
            content:
              'folder INBOX envelopeId m1 from alice date 2026-05-12 mailBody 我今天的邮箱正文示例 attachmentText 私人附件内容 rawPayload raw private payload authorization=Bearer secret-token 路径: /tmp/project/.artifacts/mail.txt',
          },
        ]),
      ]
    },
    readTraceEntries: () => {
      calls.push('readTraceEntries')
      return [
        {
          spanId: 'span_mail',
          sessionId,
          kind: 'tool_call',
          name: 'bash',
          startTime: '2026-05-12T02:31:00.000Z',
          endTime: '2026-05-12T02:31:01.000Z',
          status: 'success',
          data: {
            input: {
              command: 'himalaya account list',
              credentialRef: 'external:himalaya/account/qq',
            },
            toolResult: {
              outputSummary: 'account list ok',
              schemaKeys: ['account', 'folder', 'envelopeId', 'from', 'date'],
            },
          },
        },
      ]
    },
    readRunLog: () => {
      calls.push('readRunLog')
      return [
        {
          ts: '2026-05-12T02:31:02.000Z',
          level: 'debug',
          event: 'tool_call.raw_result',
          sessionId,
          data: {
            tool: 'bash',
            result: {
              output: 'cookie=private password=private token=private himalaya envelope metadata',
            },
          },
        },
      ]
    },
    readArtifacts: (_id, options) => {
      calls.push(`readArtifacts:${options.artifactRefs.length}`)
      return [
        {
          ref: options.artifactRefs[0] ?? '/tmp/project/.artifacts/mail.txt',
          path: '/tmp/project/.artifacts/mail.txt',
          text: '{"folder":"INBOX","envelopeId":"m1","from":"alice","mailBody":"我今天的邮箱正文示例","attachmentText":"私人附件内容","rawPayload":"raw private payload","credentialRef":"external:himalaya/account/qq","token":"private"}',
        },
      ]
    },
  }
}

function createMarketReader(): SessionSourceMinerReader {
  return {
    readSession: (id) => ({ id, source: 'web' }),
    readMessages: (id) => [
      {
        id: 'msg_market',
        sessionId: id,
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

function createService(): {
  manager: SourceCardManager
  service: SourceCardService
} {
  const dir = mkdtempSync(join(tmpdir(), 'zero-source-card-miner-'))
  tempDirs.push(dir)
  const manager = new SourceCardManager(dir)
  return { manager, service: new SourceCardService(manager) }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('SessionSourceMiner', () => {
  test('generates a draft from a specified session without executing external sources', () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('external fetch must not run')
    }) as unknown as typeof fetch
    const calls: string[] = []

    try {
      const miner = new SessionSourceMiner({
        reader: createReader(calls),
        listSourceCards: () => [],
      })

      const draft = miner.generateDraft(sessionId)
      const text = JSON.stringify(draft)

      expect(draft.sourceSessionId).toBe(sessionId)
      expect(draft.proposedCard.state).toBe('draft')
      expect(draft.proposedCard.title).toBe('QQ Mail source')
      expect(draft.proposedCard.sensitivity).toBe('private')
      expect(draft.proposedCard.tags).toEqual(
        expect.arrayContaining(['mail', 'qq-mail', 'himalaya']),
      )
      expect(draft.proposedCard.sourceDoc.body).toContain('## How to use')
      expect(draft.proposedCard.sourceDoc.body).toContain('himalaya CLI metadata commands')
      expect(draft.evidenceRefs.map((ref) => ref.source)).toEqual(
        expect.arrayContaining(['message', 'trace', 'run_log', 'artifact']),
      )
      expect(draft.triggerSnapshot).toMatchObject({
        sessionId,
        traceEntryCount: 1,
        runLogEntryCount: 1,
        messageCount: 2,
      })
      expect(draft.riskFlags.join('\n')).toContain('Did not execute CLI/API/browser/fetch')
      expect(draft.confidence).toBeGreaterThan(0.5)
      expect(calls).toEqual([
        'readSession',
        'readMessages',
        'readTraceEntries',
        'readRunLog',
        'readArtifacts:1',
      ])
      expect(text).not.toContain('secret-token')
      expect(text).not.toContain('credentialRef')
      expect(text).not.toContain('credentialLeaseId')
      expect(text).not.toContain('external:himalaya/account/qq')
      expect(text).not.toMatch(/authorization|cookie|password|token/i)

      const evidenceSummaryText = draft.evidenceRefs.map((ref) => ref.summary).join('\n')
      expect(evidenceSummaryText).toContain('metadata-only summary')
      expect(evidenceSummaryText).toContain('cli:himalaya')
      expect(evidenceSummaryText).not.toContain('我今天的邮箱正文示例')
      expect(evidenceSummaryText).not.toContain('私人附件内容')
      expect(evidenceSummaryText).not.toContain('raw private payload')
      expect(evidenceSummaryText).not.toMatch(/mailBody|attachmentText|rawPayload/i)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('createFromDraft recomputes dedupe candidates server-side', () => {
    const calls: string[] = []
    const miner = new SessionSourceMiner({
      reader: createReader(calls),
      listSourceCards: () => [],
    })
    const { service, manager } = createService()
    manager.create(createExistingMailCard())
    const draft = {
      ...miner.generateDraft(sessionId),
      dedupeCandidates: [],
    }

    expect(draft.dedupeCandidates).toEqual([])
    expect(() => service.createFromDraft({ draft, confirm: true })).toThrow('dedupeDecision')
    expect(() =>
      service.createFromDraft({
        draft,
        confirm: true,
        dedupeDecision: 'append_evidence',
      }),
    ).toThrow('not implemented')

    expect(
      service.createFromDraft({
        draft,
        confirm: true,
        dedupeDecision: 'new_card',
      }).state,
    ).toBe('draft')
  })

  test('reports dedupe candidates and requires explicit creation confirmation', () => {
    const calls: string[] = []
    const existing = createExistingMailCard()
    const miner = new SessionSourceMiner({
      reader: createReader(calls),
      listSourceCards: () => [existing],
    })
    const { manager, service } = createService()
    const draft = miner.generateDraft(sessionId)

    expect(draft.dedupeCandidates.map((candidate) => candidate.id)).toContain(existing.id)
    expect(() => service.createFromDraft({ draft, confirm: false })).toThrow('confirm=true')

    const created = service.createFromDraft({
      draft,
      confirm: true,
      dedupeDecision: 'new_card',
    })

    expect(created.state).toBe('draft')
    expect(created).not.toHaveProperty('credentials')
    expect(manager.get(draft.proposedCard.id)?.state).toBe('draft')
  })

  test('validates drafts through the Source Card document validation boundary', () => {
    const miner = new SessionSourceMiner({
      reader: createMarketReader(),
      listSourceCards: () => [],
    })
    const { service } = createService()
    const draft = miner.generateDraft(sessionId)

    expect(service.validateDraft(draft)).toMatchObject({ ok: true })
    expect(
      service.validateDraft({
        ...draft,
        proposedCard: {
          ...draft.proposedCard,
          sourceDoc: {
            format: 'markdown',
            body: 'Use external:himalaya/account/qq directly.',
          },
        },
      }).ok,
    ).toBe(false)
  })
})
