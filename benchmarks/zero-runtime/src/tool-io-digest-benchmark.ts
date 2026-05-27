import { Database } from 'bun:sqlite'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnthropicDeepSeekAdapter, type ProviderAdapter } from '@zero-os/model'
import { Vault, getMasterKey } from '@zero-os/secrets'
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from '@zero-os/shared'

export type ToolIoDigestSecretSource = 'vault' | 'env'
export type ToolIoDigestScope = 'single' | 'group'

export interface ToolIoDigestBenchmarkOptions {
  dbPath: string
  outDir: string
  sessionIds?: string[]
  sessionLimit: number
  sampleLimit: number
  reps: number
  concurrency: number
  model: string
  secretSource: ToolIoDigestSecretSource
  maxTokens: number
  maxRawCharsPerTool: number
  groupSize: number
  variants?: string[]
}

export interface ToolIoDigestVariant {
  id: string
  title: string
  hypothesis: string
  scope: ToolIoDigestScope
}

export interface ToolIoPair {
  sessionId: string
  toolUseId: string
  toolName: string
  toolMessageId: string
  resultMessageId: string
  toolMessageIndex: number
  resultMessageIndex: number
  assistantContext: string
  previousUserText: string
  toolInputRaw: string
  toolResultRaw: string
  outputSummary?: string
  isError?: boolean
  inputChars: number
  resultChars: number
}

export interface ToolIoDigestSample {
  id: string
  sessionId: string
  messageCount: number
  messageJsonChars: number
  singlePair: ToolIoPair
  groupPairs: ToolIoPair[]
  singleRawChars: number
  groupRawChars: number
  handleTerms: string[]
  previousUserPreview: string
}

export interface ToolIoDigestRunResult {
  variantId: string
  variantTitle: string
  rep: number
  sampleId: string
  sessionId: string
  scope: ToolIoDigestScope
  toolCount: number
  model: string
  parseOk: boolean
  handleCoverageScore: number | null
  toolCoverageScore: number
  compressionRatioPercent: number
  missingHandles: string[]
  inputTokens: number
  outputTokens: number
  durationMs: number
  promptChars: number
  rawChars: number
  responseChars: number
  error?: string
}

export interface ToolIoDigestVariantSummary {
  variantId: string
  title: string
  hypothesis: string
  runCount: number
  parseRate: number
  avgHandleCoverageScore: number | null
  avgToolCoverageScore: number
  avgCompressionRatioPercent: number
  avgInputTokens: number
  avgOutputTokens: number
  avgDurationMs: number
}

export interface RedactedToolIoDigestSample
  extends Omit<ToolIoDigestSample, 'singlePair' | 'groupPairs'> {
  singleToolName: string
  groupToolNames: string[]
  groupToolUseIds: string[]
}

export interface ToolIoDigestBenchmarkReport {
  generatedAt: string
  dbPath: string
  model: string
  options: {
    sessionLimit: number
    sampleLimit: number
    reps: number
    concurrency: number
    maxTokens: number
    maxRawCharsPerTool: number
    groupSize: number
  }
  variants: ToolIoDigestVariant[]
  samples: RedactedToolIoDigestSample[]
  summaries: ToolIoDigestVariantSummary[]
  results: ToolIoDigestRunResult[]
}

export interface ToolIoDigestSessionRow {
  sessionId: string
  messageCount: number
  messageJsonChars: number
  messagesJson: string
}

interface PendingToolUse {
  block: ToolUseBlock
  message: Message
  messageIndex: number
  assistantContext: string
  previousUserText: string
}

export const TOOL_IO_DIGEST_VARIANTS: ToolIoDigestVariant[] = [
  {
    id: 'SINGLE_NL',
    title: '单工具环境摘要',
    hypothesis:
      '只压缩一个 tool_use/tool_result 对，把它作为局部环境观察摘要，检查是否足够替代原始 IO。',
    scope: 'single',
  },
  {
    id: 'GROUP_NL',
    title: '连续工具链环境摘要',
    hypothesis:
      '把连续 tool IO 一起压缩成局部环境摘要，检查是否比单工具摘要更能保留阶段性观察和精确 handle。',
    scope: 'group',
  },
]

const TOOL_IO_DIGEST_SYSTEM_PROMPT = `你是 ZeRo OS 的 Tool IO Digest Model。
你的任务是把一段 tool_use + tool_result 原始 IO 压缩成后续 context compaction 可以安全替代原文的小包。

硬性规则：
- 你只看得到本次输入里的工具 IO；不要假装看到了完整会话上下文。
- 路径、URL、ID、文件名、目录名、命令 flag、配置 key、模型名、函数名、类名属于 exact handle，必须尽量原样保留。
- 不要把工具输出原文整段搬运到 digest；要提炼“实际看了/写了/运行了什么”和“从结果里学到了什么”。
- 不要解释工具为什么被调用；单个工具或局部工具链缺少完整上下文，这一层只负责整理环境观察。
- digest 未来会替代 prompt 主线中的原始 tool_use/tool_result；原始 IO 仍保留在 trace/session/evidence 中用于回看。`

export function parseToolIoDigestBenchmarkArgs(argv: string[]): ToolIoDigestBenchmarkOptions {
  const cwd = process.cwd()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const options: ToolIoDigestBenchmarkOptions = {
    dbPath: join(cwd, '.zero', 'logs', 'sessions.db'),
    outDir: join(cwd, 'benchmarks', 'zero-runtime', 'results', `tool-io-digest-${timestamp}`),
    sessionLimit: 10,
    sampleLimit: 6,
    reps: 1,
    concurrency: 3,
    model: 'deepseek-v4-flash',
    secretSource: 'vault',
    maxTokens: 4096,
    maxRawCharsPerTool: 24000,
    groupSize: 4,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--db' && next) {
      options.dbPath = next
      index++
    } else if (arg === '--out' && next) {
      options.outDir = next
      index++
    } else if (arg === '--sessions' && next) {
      options.sessionIds = splitList(next)
      index++
    } else if (arg === '--limit' && next) {
      options.sessionLimit = positiveInt(next, options.sessionLimit)
      index++
    } else if (arg === '--samples' && next) {
      options.sampleLimit = positiveInt(next, options.sampleLimit)
      index++
    } else if (arg === '--reps' && next) {
      options.reps = positiveInt(next, options.reps)
      index++
    } else if (arg === '--concurrency' && next) {
      options.concurrency = positiveInt(next, options.concurrency)
      index++
    } else if (arg === '--model' && next) {
      options.model = next
      index++
    } else if (arg === '--secret-source' && next) {
      options.secretSource = next === 'env' ? 'env' : 'vault'
      index++
    } else if (arg === '--variants' && next) {
      options.variants = splitList(next)
      index++
    } else if (arg === '--max-tokens' && next) {
      options.maxTokens = positiveInt(next, options.maxTokens)
      index++
    } else if (arg === '--max-raw-chars-per-tool' && next) {
      options.maxRawCharsPerTool = positiveInt(next, options.maxRawCharsPerTool)
      index++
    } else if (arg === '--group-size' && next) {
      options.groupSize = positiveInt(next, options.groupSize)
      index++
    } else if (arg === '--help' || arg === '-h') {
      printToolIoDigestBenchmarkHelp()
      process.exit(0)
    }
  }

  return options
}

export function printToolIoDigestBenchmarkHelp(): void {
  console.log(`Usage: bun run compaction:tool-io-digest [options]

Options:
  --db <path>                    sessions.db path (default .zero/logs/sessions.db)
  --out <dir>                    output directory
  --sessions <ids>               comma-separated session ids; defaults to long sessions by JSON size
  --limit <n>                    number of sessions to scan (default 10)
  --samples <n>                  number of benchmark samples to keep (default 6)
  --reps <n>                     runs per sample/variant (default 1)
  --concurrency <n>              concurrent API calls (default 3)
  --model <id>                   DeepSeek model id (default deepseek-v4-flash)
  --secret-source <vault|env>    read deepseek_api_key from vault or env (default vault)
  --variants <ids>               comma-separated variant ids
  --max-tokens <n>               max output tokens per call (default 4096)
  --max-raw-chars-per-tool <n>   raw tool result chars kept per tool (default 24000)
  --group-size <n>               max consecutive tool pairs per group sample (default 4)
`)
}

export async function runToolIoDigestBenchmark(
  options: ToolIoDigestBenchmarkOptions,
): Promise<ToolIoDigestBenchmarkReport> {
  const variants = selectVariants(options.variants)
  const db = new Database(options.dbPath, { readonly: true })
  try {
    const rows = loadSessionRows(db, options)
    const samples = buildToolIoDigestSamples(rows, options)
    const adapter = await createDeepSeekAdapter(options)
    mkdirSync(options.outDir, { recursive: true })
    writeFileSync(
      join(options.outDir, 'samples.json'),
      JSON.stringify(redactSamples(samples), null, 2),
    )
    writeFileSync(join(options.outDir, 'variants.md'), renderVariantsMarkdown(variants), 'utf-8')

    const tasks: Array<() => Promise<ToolIoDigestRunResult>> = []
    for (const sample of samples) {
      for (const variant of variants) {
        for (let rep = 1; rep <= options.reps; rep++) {
          tasks.push(() => runDigestVariant({ sample, variant, rep, adapter, options }))
        }
      }
    }

    const resultsPath = join(options.outDir, 'runs.jsonl')
    const results = await runWithConcurrency(tasks, options.concurrency, (result) => {
      appendFileSync(resultsPath, `${JSON.stringify(result)}\n`, 'utf-8')
      console.log(
        `[tool-io-digest] ${result.variantId} rep=${result.rep} sample=${result.sampleId} handles=${formatMaybe(result.handleCoverageScore)} tools=${result.toolCoverageScore.toFixed(1)} compression=${result.compressionRatioPercent.toFixed(1)}% parse=${result.parseOk ? 'ok' : 'fail'}`,
      )
    })

    const report: ToolIoDigestBenchmarkReport = {
      generatedAt: new Date().toISOString(),
      dbPath: options.dbPath,
      model: options.model,
      options: {
        sessionLimit: options.sessionLimit,
        sampleLimit: options.sampleLimit,
        reps: options.reps,
        concurrency: options.concurrency,
        maxTokens: options.maxTokens,
        maxRawCharsPerTool: options.maxRawCharsPerTool,
        groupSize: options.groupSize,
      },
      variants,
      samples: redactSamples(samples),
      summaries: summarizeVariants(variants, results),
      results,
    }
    writeFileSync(join(options.outDir, 'summary.json'), JSON.stringify(report, null, 2), 'utf-8')
    writeFileSync(join(options.outDir, 'report.md'), renderToolIoDigestMarkdown(report), 'utf-8')
    return report
  } finally {
    db.close()
  }
}

export function buildToolIoDigestSamples(
  rows: ToolIoDigestSessionRow[],
  options: Pick<ToolIoDigestBenchmarkOptions, 'sampleLimit' | 'groupSize'>,
): ToolIoDigestSample[] {
  const candidates = rows.flatMap((row) => {
    const messages = parseMessages(row.messagesJson)
    const pairs = extractToolIoPairs(messages, row.sessionId)
    if (pairs.length === 0) return []
    const rankedPairs = [...pairs].sort((left, right) => pairRawChars(right) - pairRawChars(left))
    const topPair = rankedPairs[0]
    if (!topPair) return []
    const groupPairs = buildConsecutiveGroup(pairs, topPair, options.groupSize)
    const selectedForTerms = groupPairs.length > 1 ? groupPairs : [topPair]
    return [
      {
        id: `${row.sessionId}_${hashish(topPair.toolUseId, groupPairs.length)}`,
        sessionId: row.sessionId,
        messageCount: row.messageCount,
        messageJsonChars: row.messageJsonChars,
        singlePair: topPair,
        groupPairs: groupPairs.length > 0 ? groupPairs : [topPair],
        singleRawChars: pairRawChars(topPair),
        groupRawChars: groupPairs.reduce((sum, pair) => sum + pairRawChars(pair), 0),
        handleTerms: extractHandleTerms(selectedForTerms.map(pairToRawText).join('\n')),
        previousUserPreview: preview(topPair.previousUserText, 220),
      },
    ]
  })

  return candidates
    .filter((sample) => sample.singleRawChars > 0)
    .sort(
      (left, right) =>
        right.singleRawChars + right.groupRawChars - (left.singleRawChars + left.groupRawChars),
    )
    .slice(0, options.sampleLimit)
}

export function extractToolIoPairs(
  messages: Message[],
  fallbackSessionId = 'unknown',
): ToolIoPair[] {
  const pending = new Map<string, PendingToolUse>()
  const pairs: ToolIoPair[] = []
  let lastHumanText = ''

  messages.forEach((message, messageIndex) => {
    const text = extractText(message.content)
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        pending.set(block.id, {
          block,
          message,
          messageIndex,
          assistantContext: message.role === 'assistant' ? text : '',
          previousUserText: lastHumanText,
        })
      }
      if (block.type === 'tool_result') {
        const toolUse = pending.get(block.toolUseId)
        const toolInputRaw = toolUse ? stableStringify(toolUse.block.input) : ''
        const resultRaw = readToolResultRaw(block)
        pairs.push({
          sessionId: message.sessionId || toolUse?.message.sessionId || fallbackSessionId,
          toolUseId: block.toolUseId,
          toolName: toolUse?.block.name ?? block.evidence?.toolName ?? 'unknown_tool',
          toolMessageId: toolUse?.message.id ?? 'unknown_tool_message',
          resultMessageId: message.id,
          toolMessageIndex: toolUse?.messageIndex ?? messageIndex,
          resultMessageIndex: messageIndex,
          assistantContext: toolUse?.assistantContext ?? '',
          previousUserText: toolUse?.previousUserText ?? lastHumanText,
          toolInputRaw,
          toolResultRaw: resultRaw,
          outputSummary: block.outputSummary,
          isError: block.isError,
          inputChars: toolInputRaw.length,
          resultChars: resultRaw.length,
        })
        pending.delete(block.toolUseId)
      }
    }

    if (
      message.role === 'user' &&
      text.trim().length > 0 &&
      !message.content.some((block) => block.type === 'tool_result') &&
      !isSystemNotice(text)
    ) {
      lastHumanText = text
    }
  })

  return pairs.sort((left, right) => left.toolMessageIndex - right.toolMessageIndex)
}

export function extractHandleTerms(text: string, limit = 80): string[] {
  const patterns = [
    /https?:\/\/[^\s"'<>()[\]{}]+/g,
    /(?:\/Users|\/tmp|\/private|\.zero|\.\/)[^\s"'<>()[\]{}]+/g,
    /[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10}\b/g,
    /\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_.]*\b/g,
    /--?[A-Za-z0-9][A-Za-z0-9_-]+\b/g,
    /\b(?:sess|msg|tool|call|resp|task|trace|run)_[A-Za-z0-9_-]{6,}\b/g,
    /\b[A-Fa-f0-9]{12,}\b/g,
  ]
  const seen = new Set<string>()
  const terms: string[] = []
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const term = trimHandle(match[0])
      const normalized = normalizeForMatch(term)
      if (term.length < 4 || seen.has(normalized) || isNoisyHandle(term)) continue
      seen.add(normalized)
      terms.push(term)
      if (terms.length >= limit) return terms
    }
  }
  return terms
}

export function scoreDigestText(params: {
  responseText: string
  pairs: ToolIoPair[]
  variant: ToolIoDigestVariant
  handleTerms: string[]
  rawChars: number
}): Pick<
  ToolIoDigestRunResult,
  | 'parseOk'
  | 'handleCoverageScore'
  | 'toolCoverageScore'
  | 'compressionRatioPercent'
  | 'missingHandles'
> {
  const response = params.responseText.trim()
  const normalizedResponse = normalizeForMatch(response)
  const matchedHandles = params.handleTerms.filter((term) =>
    normalizedResponse.includes(normalizeForMatch(term)),
  )
  const missingHandles = params.handleTerms.filter(
    (term) => !normalizedResponse.includes(normalizeForMatch(term)),
  )
  const handleCoverageScore =
    params.handleTerms.length > 0
      ? roundOne((matchedHandles.length / params.handleTerms.length) * 100)
      : null
  const toolHits = params.pairs.filter(
    (pair) =>
      normalizedResponse.includes(normalizeForMatch(pair.toolUseId)) ||
      normalizedResponse.includes(normalizeForMatch(pair.toolName)),
  ).length
  const toolCoverageScore = percent(toolHits, params.pairs.length)
  return {
    parseOk: parseDigestOk(response),
    handleCoverageScore,
    toolCoverageScore,
    compressionRatioPercent: roundOne((response.length / Math.max(1, params.rawChars)) * 100),
    missingHandles: missingHandles.slice(0, 12),
  }
}

export function renderToolIoDigestMarkdown(report: ToolIoDigestBenchmarkReport): string {
  const ranked = [...report.summaries].sort(compareVariantSummary)
  return [
    '# Tool IO Digest Benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    `Model: \`${report.model}\``,
    `Runs: ${report.results.length} (${report.samples.length} samples x ${report.variants.length} variants x ${report.options.reps} reps)`,
    '',
    '## Variant Summary',
    '',
    '| rank | variant | usable | handles | tools | compression | input tokens | output tokens | duration |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...ranked.map((summary, index) =>
      markdownRow([
        index + 1,
        `\`${summary.variantId}\` ${escapeMarkdown(summary.title)}`,
        formatPercent(summary.parseRate),
        formatMaybe(summary.avgHandleCoverageScore),
        summary.avgToolCoverageScore.toFixed(1),
        `${summary.avgCompressionRatioPercent.toFixed(1)}%`,
        summary.avgInputTokens.toFixed(1),
        summary.avgOutputTokens.toFixed(1),
        `${summary.avgDurationMs.toFixed(0)}ms`,
      ]),
    ),
    '',
    '## Samples',
    '',
    '| sample | session | raw MB | single | group | group raw chars | handles | previous user |',
    '| --- | --- | ---: | --- | --- | ---: | ---: | --- |',
    ...report.samples.map((sample) =>
      markdownRow([
        `\`${sample.id}\``,
        `\`${sample.sessionId}\``,
        (sample.messageJsonChars / 1024 / 1024).toFixed(1),
        escapeMarkdown(sample.singleToolName),
        escapeMarkdown(sample.groupToolNames.join(' -> ')),
        sample.groupRawChars,
        sample.handleTerms.length,
        escapeMarkdown(sample.previousUserPreview),
      ]),
    ),
    '',
    '## Worst Handle Runs',
    '',
    '| variant | sample | scope | tools | handle score | compression | missing handles |',
    '| --- | --- | --- | ---: | ---: | ---: | --- |',
    ...[...report.results]
      .sort(
        (left, right) =>
          (left.handleCoverageScore ?? -1) - (right.handleCoverageScore ?? -1) ||
          left.compressionRatioPercent - right.compressionRatioPercent,
      )
      .slice(0, 20)
      .map((result) =>
        markdownRow([
          `\`${result.variantId}\``,
          `\`${result.sampleId}\``,
          result.scope,
          result.toolCount,
          formatMaybe(result.handleCoverageScore),
          `${result.compressionRatioPercent.toFixed(1)}%`,
          result.missingHandles.map((item) => `\`${escapeMarkdown(item)}\``).join(', ') || '-',
        ]),
      ),
    '',
  ].join('\n')
}

async function runDigestVariant(params: {
  sample: ToolIoDigestSample
  variant: ToolIoDigestVariant
  rep: number
  adapter: ProviderAdapter
  options: ToolIoDigestBenchmarkOptions
}): Promise<ToolIoDigestRunResult> {
  const pairs =
    params.variant.scope === 'single' ? [params.sample.singlePair] : params.sample.groupPairs
  const prompt = buildToolIoDigestPrompt({
    sample: params.sample,
    pairs,
    variant: params.variant,
    maxRawCharsPerTool: params.options.maxRawCharsPerTool,
  })
  const rawChars = pairs.reduce((sum, pair) => sum + pairRawChars(pair), 0)
  const handleTerms = extractHandleTerms(pairs.map(pairToRawText).join('\n'))
  const startedAt = Date.now()
  try {
    const response = await completeWithRetry(
      params.adapter,
      {
        messages: [
          {
            id: `tool_io_digest_${params.sample.id}_${params.variant.id}_${params.rep}`,
            sessionId: params.sample.sessionId,
            role: 'user',
            messageType: 'message',
            content: [{ type: 'text', text: prompt }],
            createdAt: new Date().toISOString(),
          },
        ],
        system: TOOL_IO_DIGEST_SYSTEM_PROMPT,
        stream: false,
        maxTokens: params.options.maxTokens,
        reasoningEffort: 'low',
        meta: {
          sessionId: params.sample.sessionId,
          purpose: 'tool_io_digest_benchmark',
        },
      },
      2,
    )
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
    const score = scoreDigestText({
      responseText: text,
      pairs,
      variant: params.variant,
      handleTerms,
      rawChars,
    })
    return {
      variantId: params.variant.id,
      variantTitle: params.variant.title,
      rep: params.rep,
      sampleId: params.sample.id,
      sessionId: params.sample.sessionId,
      scope: params.variant.scope,
      toolCount: pairs.length,
      model: response.model || params.options.model,
      ...score,
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
      durationMs: Date.now() - startedAt,
      promptChars: prompt.length,
      rawChars,
      responseChars: text.length,
    }
  } catch (error) {
    return {
      variantId: params.variant.id,
      variantTitle: params.variant.title,
      rep: params.rep,
      sampleId: params.sample.id,
      sessionId: params.sample.sessionId,
      scope: params.variant.scope,
      toolCount: pairs.length,
      model: params.options.model,
      parseOk: false,
      handleCoverageScore: 0,
      toolCoverageScore: 0,
      compressionRatioPercent: 0,
      missingHandles: handleTerms.slice(0, 12),
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - startedAt,
      promptChars: prompt.length,
      rawChars,
      responseChars: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function buildToolIoDigestPrompt(params: {
  sample: ToolIoDigestSample
  pairs: ToolIoPair[]
  variant: ToolIoDigestVariant
  maxRawCharsPerTool: number
}): string {
  return [
    '<task>',
    '请把下面的 ZeRo OS 工具 IO 压缩成一个可以替代原始 tool_use/tool_result 的 digest。',
    '本输入刻意只提供单个工具或局部连续工具链；这一层只做环境观察摘要，不解释完整任务动机。',
    '- 不要解释工具调用动机，也不要写“用户为什么要这样做”。',
    '- 对每个工具保留：tool_use_id、tool_name、输入里关键参数、结果里的关键观察、后续可能复用的 exact handles。',
    '- 如果连续工具之间形成了阶段性结论，可以写 group_summary；但不要让组摘要吞掉单个工具的重要 handle。',
    '</task>',
    '',
    '<output_contract>',
    naturalOutputRules(),
    '</output_contract>',
    '',
    `<sample session_id="${escapeAttr(params.sample.sessionId)}" sample_id="${escapeAttr(params.sample.id)}" scope="${params.variant.scope}">`,
    ...params.pairs.flatMap((pair, index) =>
      renderToolPacket(pair, index + 1, params.maxRawCharsPerTool),
    ),
    '</sample>',
  ].join('\n')
}

function naturalOutputRules(): string {
  return [
    '输出用简洁中文自然语言，不要输出 JSON/XML，不要输出 Markdown 围栏。',
    '建议结构：',
    '环境摘要：这段工具 IO 展示了什么环境状态、文件/网络/命令/数据结果。',
    '逐工具摘要：',
    '- T1 / tool_use_id / tool_name：输入关键参数；结果关键观察；后续必须保留的 exact handles。',
    '可复用原文标识：列出路径、URL、ID、文件名、命令 flag、模型名、配置 key 等 exact handles。',
    '仍需回看原文：列出过大、过碎或不能安全省略的原始输出范围。',
  ].join('\n')
}

function renderToolPacket(
  pair: ToolIoPair,
  refNumber: number,
  maxRawCharsPerTool: number,
): string[] {
  const toolInput = truncateMiddle(pair.toolInputRaw, Math.min(maxRawCharsPerTool, 12000))
  const toolResult = truncateMiddle(pair.toolResultRaw, maxRawCharsPerTool)
  return [
    `<tool_packet ref="T${refNumber}" tool_use_id="${escapeAttr(pair.toolUseId)}" tool_name="${escapeAttr(pair.toolName)}" tool_message_id="${escapeAttr(pair.toolMessageId)}" result_message_id="${escapeAttr(pair.resultMessageId)}" result_status="${pair.isError ? 'error' : 'success'}" input_chars="${pair.inputChars}" result_chars="${pair.resultChars}">`,
    pair.outputSummary
      ? `<output_summary>${escapeXml(pair.outputSummary)}</output_summary>`
      : undefined,
    '<tool_use_input_raw><![CDATA[',
    sanitizeCdata(toolInput),
    ']]></tool_use_input_raw>',
    '<tool_result_raw><![CDATA[',
    sanitizeCdata(toolResult),
    ']]></tool_result_raw>',
    '</tool_packet>',
  ].filter((line): line is string => typeof line === 'string')
}

function summarizeVariants(
  variants: ToolIoDigestVariant[],
  results: ToolIoDigestRunResult[],
): ToolIoDigestVariantSummary[] {
  return variants.map((variant) => {
    const items = results.filter((item) => item.variantId === variant.id)
    return {
      variantId: variant.id,
      title: variant.title,
      hypothesis: variant.hypothesis,
      runCount: items.length,
      parseRate: percent(items.filter((item) => item.parseOk).length, items.length),
      avgHandleCoverageScore: nullableAvg(items.map((item) => item.handleCoverageScore)),
      avgToolCoverageScore: avg(items.map((item) => item.toolCoverageScore)),
      avgCompressionRatioPercent: avg(items.map((item) => item.compressionRatioPercent)),
      avgInputTokens: avg(items.map((item) => item.inputTokens)),
      avgOutputTokens: avg(items.map((item) => item.outputTokens)),
      avgDurationMs: avg(items.map((item) => item.durationMs)),
    }
  })
}

async function createDeepSeekAdapter(
  options: ToolIoDigestBenchmarkOptions,
): Promise<ProviderAdapter> {
  const apiKey = await loadDeepSeekApiKey(options)
  return new AnthropicDeepSeekAdapter({
    providerName: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    auth: { type: 'api_key', apiKeyRef: 'deepseek_api_key' },
    apiKey,
    modelConfig: {
      modelId: options.model,
      maxContext: 1000000,
      maxOutput: options.maxTokens,
      reasoningEffort: 'low',
      capabilities: ['reasoning'],
      tags: ['compaction', 'tool-io-digest', 'benchmark'],
    },
  })
}

async function loadDeepSeekApiKey(options: ToolIoDigestBenchmarkOptions): Promise<string> {
  if (options.secretSource === 'env') {
    const value =
      process.env.ZERO_BENCH_SECRET_DEEPSEEK_API_KEY ??
      process.env.deepseek_api_key ??
      process.env.DEEPSEEK_API_KEY
    if (!value) throw new Error('Missing deepseek_api_key in env')
    return value
  }
  const vault = new Vault(await getMasterKey(), join(process.cwd(), '.zero', 'secrets.enc'))
  vault.load()
  const value = vault.get('deepseek_api_key')?.trim()
  if (!value) throw new Error('Missing deepseek_api_key in vault')
  return value
}

async function completeWithRetry(
  adapter: ProviderAdapter,
  request: Parameters<ProviderAdapter['complete']>[0],
  retries: number,
) {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await adapter.complete(request)
    } catch (error) {
      lastError = error
      if (attempt < retries) await delay(1000 * (attempt + 1))
    }
  }
  throw lastError
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onResult: (result: T) => void,
): Promise<T[]> {
  const results: T[] = []
  let nextIndex = 0
  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++
      const result = await tasks[index]()
      results[index] = result
      onResult(result)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return results
}

function loadSessionRows(
  db: Database,
  options: Pick<ToolIoDigestBenchmarkOptions, 'sessionIds' | 'sessionLimit'>,
): ToolIoDigestSessionRow[] {
  if (options.sessionIds && options.sessionIds.length > 0) {
    const statement = db.prepare(`
      select session_id as sessionId,
             message_count as messageCount,
             length(messages_json) as messageJsonChars,
             messages_json as messagesJson
      from session_messages
      where session_id = ?
    `)
    return options.sessionIds.flatMap((sessionId) => {
      const row = statement.get(sessionId) as ToolIoDigestSessionRow | null
      return row ? [row] : []
    })
  }
  return db
    .query(
      `
        select session_id as sessionId,
               message_count as messageCount,
               length(messages_json) as messageJsonChars,
               messages_json as messagesJson
        from session_messages
        order by length(messages_json) desc
        limit $limit
      `,
    )
    .all({ $limit: options.sessionLimit }) as ToolIoDigestSessionRow[]
}

function parseMessages(raw: string): Message[] {
  const parsed = JSON.parse(raw) as unknown
  return Array.isArray(parsed) ? parsed.filter(isMessage) : []
}

function isMessage(value: unknown): value is Message {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as Message).id === 'string' &&
      Array.isArray((value as Message).content),
  )
}

function selectVariants(ids: string[] | undefined): ToolIoDigestVariant[] {
  if (!ids || ids.length === 0) return TOOL_IO_DIGEST_VARIANTS
  const wanted = new Set(ids)
  return TOOL_IO_DIGEST_VARIANTS.filter((variant) => wanted.has(variant.id))
}

function buildConsecutiveGroup(
  pairs: ToolIoPair[],
  anchor: ToolIoPair,
  groupSize: number,
): ToolIoPair[] {
  const sorted = [...pairs].sort((left, right) => left.toolMessageIndex - right.toolMessageIndex)
  const anchorIndex = sorted.findIndex((pair) => pair.toolUseId === anchor.toolUseId)
  if (anchorIndex < 0) return [anchor]
  const half = Math.floor(Math.max(1, groupSize) / 2)
  const start = Math.max(0, Math.min(anchorIndex - half, sorted.length - groupSize))
  return sorted.slice(start, start + Math.max(1, groupSize))
}

function readToolResultRaw(block: ToolResultBlock): string {
  const evidencePath = block.evidence?.path
  if (evidencePath && existsSync(evidencePath)) {
    try {
      return readFileSync(evidencePath, 'utf-8')
    } catch {
      return block.content
    }
  }
  return block.content
}

function pairToRawText(pair: ToolIoPair): string {
  return [
    pair.toolUseId,
    pair.toolName,
    pair.toolInputRaw,
    pair.outputSummary ?? '',
    pair.toolResultRaw,
  ].join('\n')
}

function pairRawChars(pair: ToolIoPair): number {
  return pair.inputChars + pair.resultChars + (pair.outputSummary?.length ?? 0)
}

function parseDigestOk(text: string): boolean {
  return text.trim().length >= 40
}

function redactSamples(samples: ToolIoDigestSample[]): RedactedToolIoDigestSample[] {
  return samples.map((sample) => ({
    id: sample.id,
    sessionId: sample.sessionId,
    messageCount: sample.messageCount,
    messageJsonChars: sample.messageJsonChars,
    singleRawChars: sample.singleRawChars,
    groupRawChars: sample.groupRawChars,
    handleTerms: sample.handleTerms,
    previousUserPreview: sample.previousUserPreview,
    singleToolName: sample.singlePair.toolName,
    groupToolNames: sample.groupPairs.map((pair) => pair.toolName),
    groupToolUseIds: sample.groupPairs.map((pair) => pair.toolUseId),
  }))
}

function renderVariantsMarkdown(variants: ToolIoDigestVariant[]): string {
  return [
    '# Tool IO Digest Variants',
    '',
    ...variants.flatMap((variant) => [
      `## ${variant.id} ${variant.title}`,
      '',
      `Scope: ${variant.scope}`,
      '',
      `Hypothesis: ${variant.hypothesis}`,
      '',
    ]),
  ].join('\n')
}

function compareVariantSummary(
  left: ToolIoDigestVariantSummary,
  right: ToolIoDigestVariantSummary,
): number {
  return (
    (right.avgHandleCoverageScore ?? -1) - (left.avgHandleCoverageScore ?? -1) ||
    right.avgToolCoverageScore - left.avgToolCoverageScore ||
    left.avgCompressionRatioPercent - right.avgCompressionRatioPercent
  )
}

function extractText(content: ContentBlock[]): string {
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, stableStringifyReplacer, 2)
}

function stableStringifyReplacer(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const edge = Math.max(1, Math.floor((maxChars - 120) / 2))
  return [
    value.slice(0, edge),
    `\n[... omitted ${value.length - edge * 2} chars from middle ...]\n`,
    value.slice(value.length - edge),
  ].join('')
}

function sanitizeCdata(value: string): string {
  return value.replaceAll(']]>', ']]]]><![CDATA[>')
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
  return escapeXml(value).replace(/"/g, '&quot;')
}

function trimHandle(value: string): string {
  return value.replace(/[),.;:]+$/g, '')
}

function isNoisyHandle(value: string): boolean {
  return (
    value === '..' ||
    value.includes('node_modules/.bin') ||
    value.endsWith('.com') ||
    /^[0-9]+$/.test(value)
  )
}

function isSystemNotice(text: string): boolean {
  return text.includes('<system_notice>') || text.includes('<system-reminder>')
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function avg(values: number[]): number {
  if (values.length === 0) return 0
  return roundOne(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function nullableAvg(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length > 0 ? avg(present) : null
}

function percent(count: number, total: number): number {
  return total > 0 ? roundOne((count / total) * 100) : 0
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10
}

function formatMaybe(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(1)
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`
}

function markdownRow(values: Array<string | number>): string {
  return `| ${values.join(' | ')} |`
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function preview(value: string | undefined, maxChars: number): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`
}

function positiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function hashish(...parts: Array<string | number>): string {
  let hash = 0
  for (const char of parts.join(':')) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return hash.toString(16)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
