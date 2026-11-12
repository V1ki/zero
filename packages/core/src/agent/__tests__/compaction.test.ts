import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import type { StartSpanOptions, TraceSpan } from '@zero-os/observe'
import type {
  CompletionRequest,
  ContentBlock,
  ContextCheckpoint,
  Message,
  SecretFilter,
} from '@zero-os/shared'
import {
  CONTEXT_CHECKPOINT_PROMPT_VERSION,
  type CheckpointSummarizer,
  type CheckpointSummaryInput,
  compactContext,
  computeCompactionBudget,
  createCheckpointSummarizer,
  isCheckpointValid,
  projectMessages,
} from '../compaction'
import { estimateConversationTokens } from '../context'

const SESSION = 'sess_compaction'

function message(id: string, role: 'user' | 'assistant', content: ContentBlock[]): Message {
  return {
    id,
    sessionId: SESSION,
    role,
    messageType: 'message',
    content,
    createdAt: '2026-11-01T00:00:00.000Z',
  }
}

function textMessage(id: string, role: 'user' | 'assistant', text: string): Message {
  return message(id, role, [{ type: 'text', text }])
}

/** assistant tool_use `a{n}` + user tool_result `u{n}` */
function toolPair(n: number, result: string): Message[] {
  return [
    message(`a${n}`, 'assistant', [
      { type: 'tool_use', id: `tu${n}`, name: 'bash', input: { command: `step ${n}` } },
    ]),
    message(`u${n}`, 'user', [{ type: 'tool_result', toolUseId: `tu${n}`, content: result }]),
  ]
}

/** 7000 字符的 tool_result，中间藏一个路径 handle */
function bigResult(n: number): string {
  const middle = ` /work/out/report-${n}.json `
  return `HEAD${n}${'h'.repeat(3000)}${middle}${'t'.repeat(3990 - middle.length)}TAIL${n}`
}

function conversation(pairs: number): Message[] {
  const messages = [textMessage('u0', 'user', '整理构建日志')]
  for (let n = 1; n <= pairs; n++) messages.push(...toolPair(n, bigResult(n)))
  return messages
}

function checkpoint(fields: Partial<ContextCheckpoint>): ContextCheckpoint {
  return {
    id: 'cp_1',
    sessionId: SESSION,
    generation: 1,
    coveredMessageCount: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...fields,
  }
}

function textOf(m: Message): string {
  return m.content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : ''))
    .join('')
}

function fakeSummarizer(texts: string[] | Error) {
  const calls: CheckpointSummaryInput[] = []
  const summarize: CheckpointSummarizer = async (input) => {
    calls.push(input)
    if (texts instanceof Error) throw texts
    return {
      text: texts[calls.length - 1],
      model: { model: 'fake', provider: 'fake', promptVersion: CONTEXT_CHECKPOINT_PROMPT_VERSION },
      usage: { input: 10, output: 5 },
    }
  }
  return { summarize, calls }
}

describe('computeCompactionBudget', () => {
  test('threshold and retain derive from the usable window', () => {
    // U = 200000 − 32000 = 168000
    expect(computeCompactionBudget(200_000, 32_000)).toEqual({
      thresholdTokens: 134_400,
      retainTokens: 33_600,
    })
  })
})

describe('projectMessages', () => {
  test('no checkpoint returns the history unchanged', () => {
    const messages = conversation(2)
    expect(projectMessages(messages, undefined)).toEqual(messages)
  })

  test('summary replaces the covered prefix', () => {
    const messages = conversation(2)
    const cp = checkpoint({ summarizedThroughMessageId: 'u1', summary: '## 当前工作\n修构建' })
    const projected = projectMessages(messages, cp)

    expect(projected).toHaveLength(3)
    expect(projected[0]).toMatchObject({ id: 'cp_1', role: 'user', messageType: 'message' })
    expect(textOf(projected[0])).toContain(
      '<context_checkpoint>\n## 当前工作\n修构建\n</context_checkpoint>',
    )
    expect(projected.slice(1)).toEqual(messages.slice(3))
  })

  test('prunes oversized tool results only up to the watermark', () => {
    const messages = [
      textMessage('u0', 'user', 'start'),
      ...toolPair(1, bigResult(1)),
      ...toolPair(2, 'small output'),
      ...toolPair(3, bigResult(3)),
    ]
    const projected = projectMessages(messages, checkpoint({ prunedThroughMessageId: 'u2' }))

    const pruned = textOf(projected[2])
    expect(pruned.startsWith('HEAD1')).toBe(true)
    expect(pruned).toContain('…[省略 ')
    expect(pruned).toContain('TAIL1')
    expect(pruned).toContain('retained_handles: /work/out/report-1.json')
    expect(pruned.length).toBeLessThan(2000)
    expect(projected[4]).toEqual(messages[4])
    expect(projected[6]).toEqual(messages[6])
  })

  test('is pure and deterministic', () => {
    const messages = conversation(3)
    const cp = checkpoint({
      prunedThroughMessageId: 'u2',
      summarizedThroughMessageId: 'u1',
      summary: 'S',
    })
    const messagesSnapshot = structuredClone(messages)
    const cpSnapshot = structuredClone(cp)

    const first = projectMessages(messages, cp)
    const second = projectMessages(messages, cp)

    expect(first).toEqual(second)
    expect(messages).toEqual(messagesSnapshot)
    expect(cp).toEqual(cpSnapshot)
  })

  test('a checkpoint pointing at missing messages is treated as absent', () => {
    const messages = conversation(2)
    const cp = checkpoint({ summarizedThroughMessageId: 'gone', summary: 'S' })
    expect(isCheckpointValid(messages, cp)).toBe(false)
    expect(isCheckpointValid(messages, checkpoint({ prunedThroughMessageId: 'u1' }))).toBe(true)
    expect(projectMessages(messages, cp)).toEqual(messages)
  })
})

describe('compactContext', () => {
  const retain = 4500

  test('below threshold does nothing', async () => {
    const { summarize, calls } = fakeSummarizer(['unused'])
    const result = await compactContext({
      messages: conversation(2),
      checkpoint: undefined,
      sessionId: SESSION,
      budget: { thresholdTokens: 100_000, retainTokens: retain },
      fixedTokens: 1000,
      summarize,
    })
    expect(result.status).toBe('not_needed')
    expect(calls).toHaveLength(0)
  })

  test('pruning alone is enough', async () => {
    const messages = conversation(6)
    const { summarize, calls } = fakeSummarizer(['unused'])
    const result = await compactContext({
      messages,
      checkpoint: undefined,
      sessionId: SESSION,
      budget: { thresholdTokens: 8000, retainTokens: retain },
      fixedTokens: 0,
      summarize,
    })

    expect(calls).toHaveLength(0)
    if (result.status !== 'pruned') throw new Error(`unexpected ${result.status}`)
    expect(result.checkpoint).toMatchObject({
      generation: 1,
      prunedThroughMessageId: 'u4',
      coveredMessageCount: 0,
    })
    expect(result.checkpoint.summary).toBeUndefined()
    expect(result.tokensAfter).toBeLessThan(8000)
    expect(result.tokensBefore).toBe(estimateConversationTokens(messages))
  })

  test('summarizes when pruning is not enough and keeps the tail verbatim', async () => {
    const messages = conversation(6)
    const { summarize, calls } = fakeSummarizer(['SUMMARY 1'])
    const result = await compactContext({
      messages,
      checkpoint: undefined,
      sessionId: SESSION,
      budget: { thresholdTokens: 5000, retainTokens: retain },
      fixedTokens: 0,
      summarize,
    })

    if (result.status !== 'summarized') throw new Error(`unexpected ${result.status}`)
    expect(calls).toHaveLength(1)
    expect(calls[0].previousSummary).toBeUndefined()
    expect(calls[0].messages.map((m) => m.id)).toEqual(messages.slice(0, 9).map((m) => m.id))
    expect(result.checkpoint).toMatchObject({
      generation: 1,
      summarizedThroughMessageId: 'u4',
      prunedThroughMessageId: 'u4',
      summary: 'SUMMARY 1',
      coveredMessageCount: 9,
    })

    const projected = projectMessages(messages, result.checkpoint)
    const tail = projected.slice(1)
    expect(tail).toEqual(messages.slice(9))
    expect(estimateConversationTokens(tail)).toBeLessThanOrEqual(retain)
    expect(result.tokensAfter).toBe(estimateConversationTokens(projected))
  })

  test('the cut never separates tool_use from tool_result', async () => {
    const messages = conversation(6)
    // 预算恰好容纳 u5、a6、u6：往回走停在 u5（tool_result），分界必须前移到 a6
    const retainTokens = estimateConversationTokens(messages.slice(-3))
    const { summarize, calls } = fakeSummarizer(['S'])
    const result = await compactContext({
      messages,
      checkpoint: undefined,
      sessionId: SESSION,
      budget: { thresholdTokens: 3000, retainTokens },
      fixedTokens: 0,
      summarize,
    })

    if (result.status !== 'summarized') throw new Error(`unexpected ${result.status}`)
    expect(result.checkpoint.summarizedThroughMessageId).toBe('u5')
    const covered = calls[0].messages
    const useIds = covered.flatMap((m) =>
      m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])),
    )
    const resultIds = covered.flatMap((m) =>
      m.content.flatMap((b) => (b.type === 'tool_result' ? [b.toolUseId] : [])),
    )
    expect(resultIds).toEqual(useIds)
    expect(projectMessages(messages, result.checkpoint)[1].id).toBe('a6')
  })

  test('a second compaction rolls the previous summary forward', async () => {
    const first = conversation(6)
    const one = await compactContext({
      messages: first,
      checkpoint: undefined,
      sessionId: SESSION,
      budget: { thresholdTokens: 5000, retainTokens: retain },
      fixedTokens: 0,
      summarize: fakeSummarizer(['SUMMARY 1']).summarize,
    })
    if (one.status !== 'summarized') throw new Error(`unexpected ${one.status}`)

    const messages = [...first, ...toolPair(7, bigResult(7)), ...toolPair(8, bigResult(8))]
    const { summarize, calls } = fakeSummarizer(['SUMMARY 2'])
    const two = await compactContext({
      messages,
      checkpoint: one.checkpoint,
      sessionId: SESSION,
      budget: { thresholdTokens: 3000, retainTokens: retain },
      fixedTokens: 0,
      summarize,
    })

    if (two.status !== 'summarized') throw new Error(`unexpected ${two.status}`)
    expect(calls[0].previousSummary).toBe('SUMMARY 1')
    expect(calls[0].messages.map((m) => m.id)).toEqual(['a5', 'u5', 'a6', 'u6'])
    expect(two.checkpoint).toMatchObject({
      generation: 2,
      summarizedThroughMessageId: 'u6',
      summary: 'SUMMARY 2',
      coveredMessageCount: 13,
    })
    expect(two.checkpoint.coveredMessageCount).toBeGreaterThan(one.checkpoint.coveredMessageCount)
  })

  test('summarizer failure keeps the previous summary and the prune advance', async () => {
    const first = conversation(6)
    const one = await compactContext({
      messages: first,
      checkpoint: undefined,
      sessionId: SESSION,
      budget: { thresholdTokens: 5000, retainTokens: retain },
      fixedTokens: 0,
      summarize: fakeSummarizer(['SUMMARY 1']).summarize,
    })
    if (one.status !== 'summarized') throw new Error(`unexpected ${one.status}`)

    const messages = [...first, ...toolPair(7, bigResult(7)), ...toolPair(8, bigResult(8))]
    const result = await compactContext({
      messages,
      checkpoint: one.checkpoint,
      sessionId: SESSION,
      budget: { thresholdTokens: 3000, retainTokens: retain },
      fixedTokens: 0,
      summarize: fakeSummarizer(new Error('provider down')).summarize,
    })

    if (result.status !== 'failed') throw new Error(`unexpected ${result.status}`)
    expect(result.error).toBe('provider down')
    expect(result.checkpoint).toMatchObject({
      generation: 2,
      prunedThroughMessageId: 'u6',
      summarizedThroughMessageId: 'u4',
      summary: 'SUMMARY 1',
      coveredMessageCount: 9,
    })
  })
})

describe('createCheckpointSummarizer', () => {
  function fakeAdapter(texts: string[]) {
    const requests: CompletionRequest[] = []
    const adapter = {
      apiType: 'fake',
      async complete(req: CompletionRequest) {
        requests.push(req)
        return {
          id: `resp_${requests.length}`,
          content: [{ type: 'text' as const, text: texts[requests.length - 1] }],
          stopReason: 'end_turn' as const,
          usage: { input: 100, output: 20 },
          model: 'fake-model',
        }
      },
      async *stream() {},
      async healthCheck() {
        return true
      },
    } satisfies ProviderAdapter
    return { adapter, requests }
  }

  function promptOf(req: CompletionRequest): string {
    return textOf(req.messages[0])
  }

  test('sends the transcript and the previous summary', async () => {
    const { adapter, requests } = fakeAdapter(['## 当前工作\n继续'])
    const spans: Array<{ name: string; options?: StartSpanOptions; status?: string }> = []
    const tracer = {
      startSpan(sessionId: string, name: string, _parentId?: string, options?: StartSpanOptions) {
        spans.push({ name, options })
        return {
          id: 'span_1',
          sessionId,
          kind: 'context_compaction',
          name,
          startTime: '',
          status: 'running',
          children: [],
        } satisfies TraceSpan
      },
      updateSpan() {},
      endSpan(_id: string, status?: string) {
        spans[0].status = status
      },
    }
    const summarize = createCheckpointSummarizer({ adapter, providerName: 'fake', tracer })

    const result = await summarize({
      sessionId: SESSION,
      previousSummary: 'PREVIOUS',
      messages: [
        textMessage('u0', 'user', 'hello world'),
        message('a1', 'assistant', [
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'ls' } },
        ]),
        message('u1', 'user', [{ type: 'tool_result', toolUseId: 'tu1', content: 'listing' }]),
      ],
    })

    expect(requests).toHaveLength(1)
    const prompt = promptOf(requests[0])
    expect(prompt).toContain('<previous_summary>\nPREVIOUS\n</previous_summary>')
    expect(prompt).toContain('hello world')
    expect(prompt).toContain('[tool_use bash] {"command":"ls"}')
    expect(prompt).toContain('listing')
    expect(prompt).not.toContain('private reasoning')
    expect(requests[0]).toMatchObject({ stream: false, meta: { purpose: 'compression' } })
    expect(result).toEqual({
      text: '## 当前工作\n继续',
      model: {
        model: 'fake-model',
        provider: 'fake',
        promptVersion: CONTEXT_CHECKPOINT_PROMPT_VERSION,
      },
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    })
    expect(spans[0]).toMatchObject({
      name: 'context_checkpoint',
      options: { kind: 'context_compaction' },
      status: 'success',
    })
  })

  test('bounds oversized tool results in the transcript', async () => {
    const { adapter, requests } = fakeAdapter(['S'])
    const huge = `START${'x'.repeat(20_000)}END`
    await createCheckpointSummarizer({ adapter })({
      sessionId: SESSION,
      messages: [message('u1', 'user', [{ type: 'tool_result', toolUseId: 't', content: huge }])],
    })
    const prompt = promptOf(requests[0])
    expect(prompt).toContain('START')
    expect(prompt).toContain('END')
    expect(prompt).toContain('…[省略 ')
    expect(prompt.length).toBeLessThan(10_000)
  })

  test('rolls over chunks when the transcript exceeds the cap', async () => {
    const { adapter, requests } = fakeAdapter(['CHUNK 1', 'CHUNK 2'])
    const messages = Array.from({ length: 30 }, (_, i) =>
      textMessage(`m${i}`, 'user', `${i} ${'y'.repeat(3000)}`),
    )
    const result = await createCheckpointSummarizer({ adapter })({ sessionId: SESSION, messages })

    expect(requests).toHaveLength(2)
    expect(promptOf(requests[0])).not.toContain('<previous_summary>\n')
    expect(promptOf(requests[1])).toContain('<previous_summary>\nCHUNK 1\n</previous_summary>')
    expect(result.text).toBe('CHUNK 2')
    expect(result.usage).toMatchObject({ input: 200, output: 40 })
  })

  test('empty model text is a failure', async () => {
    const { adapter } = fakeAdapter(['  '])
    await expect(
      createCheckpointSummarizer({ adapter })({
        sessionId: SESSION,
        messages: [textMessage('u0', 'user', 'hi')],
      }),
    ).rejects.toThrow('empty')
  })

  test('applies the secret filter to the summary', async () => {
    const { adapter } = fakeAdapter(['token secret-token used'])
    const secretFilter: SecretFilter = {
      filter: (text) => text.replaceAll('secret-token', '[REDACTED]'),
      addSecret() {},
      removeSecret() {},
    }
    const result = await createCheckpointSummarizer({ adapter, secretFilter })({
      sessionId: SESSION,
      messages: [textMessage('u0', 'user', 'hi')],
    })
    expect(result.text).toBe('token [REDACTED] used')
  })
})
