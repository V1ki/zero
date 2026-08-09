import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnthropicDeepSeekAdapter } from '@zero-os/model'
import { Vault, getMasterKey } from '@zero-os/secrets'
import type { CompletionRequest, ContentBlock, Message } from '@zero-os/shared'
import { generateId, hasSignedThinkingBlock, now } from '@zero-os/shared'

// Replays a captured failing request against the DeepSeek Anthropic endpoint N times.
// Classification mirrors the FIXED agent-loop logic: the thinking block is kept
// whenever a signature is present (text may be empty), and a response is only BAD
// when it has tool_use but no signed thinking block — the exact condition that makes
// agent-loop's assertValidDeepSeekThinkingContent throw.
//
// With FOLLOWUP=1, the captured assistant turn (thinking+tool_use) plus a synthetic
// tool_result is appended to the history and sent back THROUGH THE ADAPTER (the real
// production conversion path), verifying end-to-end that the persisted signature-only
// thinking block is replayable.

interface CapturedResponse {
  stopReason: string
  reasoning: string
  signature: string
  text: string
  toolCalls: Array<{ id: string; name: string; args: string }>
  usage: { input: number; output: number }
  content: ContentBlock[]
}

interface RunResult extends CapturedResponse {
  run: number
  durationMs: number
  bad: boolean
  error?: string
}

const EMPTY_CAPTURE: CapturedResponse = {
  stopReason: 'error',
  reasoning: '',
  signature: '',
  text: '',
  toolCalls: [],
  usage: { input: 0, output: 0 },
  content: [],
}

async function capture(
  adapter: AnthropicDeepSeekAdapter,
  request: CompletionRequest,
): Promise<CapturedResponse> {
  const reasoningParts: string[] = []
  const signatureParts: string[] = []
  const textParts: string[] = []
  const toolCalls: Array<{ id: string; name: string; args: string }> = []
  let currentTool: { id: string; name: string; args: string } | undefined
  let stopReason = 'unknown'
  let usage = { input: 0, output: 0 }

  for await (const event of adapter.stream({ ...request, stream: true })) {
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.type === 'reasoning_delta') {
      if (typeof data.text === 'string') reasoningParts.push(data.text)
    } else if (event.type === 'reasoning_signature') {
      if (typeof data.signature === 'string') signatureParts.push(data.signature)
    } else if (event.type === 'text_delta') {
      if (typeof data.text === 'string') textParts.push(data.text)
    } else if (event.type === 'tool_use_start') {
      currentTool = {
        id: typeof data.id === 'string' ? data.id : `tool_${toolCalls.length}`,
        name: typeof data.name === 'string' ? data.name : 'unknown',
        args: '',
      }
      toolCalls.push(currentTool)
    } else if (event.type === 'tool_use_delta') {
      if (currentTool && typeof data.arguments === 'string') currentTool.args += data.arguments
    } else if (event.type === 'done') {
      stopReason = typeof data.finishReason === 'string' ? data.finishReason : 'unknown'
      const u = data.usage as { input?: number; output?: number } | undefined
      if (u) usage = { input: u.input ?? 0, output: u.output ?? 0 }
    }
  }

  // Mirrors the fixed completeFromStream assembly in agent-loop.ts.
  const content: ContentBlock[] = []
  const reasoning = reasoningParts.join('')
  const signature = signatureParts.join('')
  if (signature) {
    content.push({ type: 'thinking', thinking: reasoning, signature })
  }
  if (textParts.length > 0) {
    content.push({ type: 'text', text: textParts.join('') })
  }
  for (const tool of toolCalls) {
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(tool.args || '{}')
    } catch {
      input = {}
    }
    content.push({ type: 'tool_use', id: tool.id, name: tool.name, input })
  }

  return {
    stopReason,
    reasoning,
    signature,
    text: textParts.join(''),
    toolCalls,
    usage,
    content,
  }
}

function buildMessage(role: 'assistant' | 'user', content: ContentBlock[]): Message {
  return {
    id: generateId(),
    sessionId: 'replay',
    role,
    messageType: 'message',
    content,
    createdAt: now(),
  }
}

async function main(): Promise<void> {
  const requestPath =
    process.argv[2] ?? join(process.cwd(), '.artifacts/deepseek-replay/failing-request.json')
  const runs = Number(process.argv[3] ?? 10)
  const followup = process.env.FOLLOWUP === '1'

  const request = JSON.parse(readFileSync(requestPath, 'utf-8')) as CompletionRequest

  const vault = new Vault(await getMasterKey(), join(process.cwd(), '.zero', 'secrets.enc'))
  vault.load()
  const apiKey = vault.get('deepseek_api_key')?.trim()
  if (!apiKey) throw new Error('Missing deepseek_api_key in vault')

  const adapter = new AnthropicDeepSeekAdapter({
    providerName: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    auth: { type: 'api_key', apiKeyRef: 'deepseek_api_key' },
    apiKey,
    modelConfig: {
      modelId: process.env.REPLAY_MODEL ?? 'deepseek-v4-flash',
      maxContext: 1000000,
      maxOutput: 384000,
      reasoningEffort: 'xhigh',
      capabilities: ['tools', 'reasoning'],
      tags: ['replay'],
    },
  })

  const results: RunResult[] = []
  let firstCapture: CapturedResponse | undefined

  for (let run = 1; run <= runs; run++) {
    const startedAt = Date.now()
    let error: string | undefined
    let captured: CapturedResponse | undefined

    try {
      captured = await capture(adapter, request)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    // The exact guard condition from agent-loop's assertValidDeepSeekThinkingContent.
    const bad =
      !error &&
      (captured?.toolCalls.length ?? 0) > 0 &&
      !hasSignedThinkingBlock(captured?.content ?? [])

    const result: RunResult = {
      run,
      ...(captured ?? EMPTY_CAPTURE),
      durationMs: Date.now() - startedAt,
      bad,
      ...(error ? { error } : {}),
    }
    results.push(result)
    if (!firstCapture && captured) firstCapture = captured

    console.log(
      `run ${run}: ${bad ? 'BAD (guard would throw)' : error ? `ERROR: ${error}` : 'ok'}` +
        ` | stop=${result.stopReason} tools=${result.toolCalls.length}` +
        ` reasoning=${result.reasoning.length}ch sig=${result.signature.length > 0}` +
        ` | in=${result.usage.input} out=${result.usage.output} ${result.durationMs}ms`,
    )
  }

  const badCount = results.filter((r) => r.bad).length
  const errorCount = results.filter((r) => r.error).length
  console.log(
    `\n=== tally: ${results.length} runs | bad=${badCount} | errors=${errorCount} | ok=${results.length - badCount - errorCount} ===`,
  )

  if (followup && firstCapture && firstCapture.toolCalls.length > 0) {
    console.log('\n--- follow-up probe: replay persisted history THROUGH the adapter ---')
    const tool = firstCapture.toolCalls[0]
    let toolInput: Record<string, unknown> = {}
    try {
      toolInput = JSON.parse(tool.args || '{}')
    } catch {
      toolInput = {}
    }

    const assistantContent: ContentBlock[] = [
      {
        type: 'thinking',
        thinking: firstCapture.reasoning,
        signature: firstCapture.signature,
      },
      { type: 'tool_use', id: tool.id, name: tool.name, input: toolInput },
    ]
    const followupRequest: CompletionRequest = {
      ...request,
      messages: [
        ...request.messages,
        buildMessage('assistant', assistantContent),
        buildMessage('user', [
          { type: 'tool_result', toolUseId: tool.id, content: 'OK', isError: false },
        ]),
      ],
    }

    console.log(
      `replaying thinking=${firstCapture.reasoning.length}ch signature=${firstCapture.signature.length}ch + tool_use(${tool.name}) + tool_result`,
    )
    try {
      const next = await capture(adapter, followupRequest)
      const nextBad = next.toolCalls.length > 0 && !hasSignedThinkingBlock(next.content)
      console.log(
        `follow-up ${nextBad ? 'BAD (guard would throw)' : 'ACCEPTED'} | stop=${next.stopReason}` +
          ` tools=${next.toolCalls.length} thinking=${next.reasoning.length}ch` +
          ` sig=${next.signature.length > 0} text=${next.text.length}ch` +
          ` in=${next.usage.input} out=${next.usage.output}`,
      )
    } catch (err) {
      console.log(`follow-up REJECTED: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

await main()
