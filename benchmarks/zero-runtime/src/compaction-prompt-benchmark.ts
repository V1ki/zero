import { Database } from 'bun:sqlite'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnthropicDeepSeekAdapter, type ProviderAdapter } from '@zero-os/model'
import { Vault, getMasterKey } from '@zero-os/secrets'
import type { ContentBlock, Message } from '@zero-os/shared'
import {
  CONTEXT_COMPACTION_SYSTEM_PROMPT,
  buildContextCompactionPrompt,
  parseContextCompactionModelOutput,
} from '../../../packages/core/src/agent/compress'
import type {
  ContextCompactionModelInput,
  ContextCompactionModelOutput,
} from '../../../packages/core/src/agent/context'
import {
  buildEpisodeCompaction,
  buildWorkingStateCompaction,
  formatWorkingState,
} from '../../../packages/core/src/agent/evidence'
import { scoreCompactedContext } from './compaction-quality'

export type PromptBenchSecretSource = 'vault' | 'env'

export interface PromptBenchmarkOptions {
  dbPath: string
  outDir: string
  sessionIds?: string[]
  sessionLimit: number
  reps: number
  concurrency: number
  model: string
  secretSource: PromptBenchSecretSource
  maxTokens: number
  keepArtifacts: boolean
  variants?: string[]
}

export interface PromptVariant {
  id: string
  title: string
  hypothesis: string
  instruction: string
}

export interface PromptBenchmarkSample {
  sessionId: string
  messageCount: number
  messageJsonChars: number
  checkpointTurnOrdinal: number
  prefixMessageCount: number
  segmentMessageCount: number
  retainedMessageCount: number
  segmentToolUseCount: number
  oracleTermCount: number
  exactHandleTermCount: number
  futureToolArgTermCount: number
  nextUserPreview: string
  input: ContextCompactionModelInput
  prefixMessages: Message[]
  retainedMessages: Message[]
  futureWindow: Message[]
}

export interface PromptBenchmarkRunResult {
  variantId: string
  variantTitle: string
  rep: number
  sessionId: string
  model: string
  parseOk: boolean
  validationStatus?: string
  topicCount: number
  missingToolRefCount: number
  compactScore: number | null
  accuracyLossPercent: number | null
  exactHandleScore: number | null
  futureToolArgScore: number | null
  oracleTermCount: number
  exactHandleTermCount: number
  futureToolArgTermCount: number
  missingExamples: string[]
  inputTokens: number
  outputTokens: number
  durationMs: number
  promptChars: number
  responseChars: number
  error?: string
}

export interface PromptVariantSummary {
  variantId: string
  title: string
  hypothesis: string
  runCount: number
  parseRate: number
  validationPassRate: number
  avgCompactScore: number | null
  avgAccuracyLossPercent: number | null
  avgExactHandleScore: number | null
  avgFutureToolArgScore: number | null
  avgMissingToolRefCount: number
  avgInputTokens: number
  avgOutputTokens: number
  stabilityStddev: number | null
}

export interface PromptBenchmarkReport {
  generatedAt: string
  dbPath: string
  model: string
  options: {
    sessionLimit: number
    reps: number
    concurrency: number
    maxTokens: number
  }
  variants: PromptVariant[]
  samples: Omit<
    PromptBenchmarkSample,
    'input' | 'prefixMessages' | 'retainedMessages' | 'futureWindow'
  >[]
  summaries: PromptVariantSummary[]
  results: PromptBenchmarkRunResult[]
}

interface SessionRow {
  sessionId: string
  messageCount: number
  messageJsonChars: number
  messagesJson: string
}

interface CandidateSample {
  turnOrdinal: number
  messageIndex: number
  nextMessageIndex: number
  score: number
  prefixMessages: Message[]
  segment: Message[]
  retainedMessages: Message[]
  futureWindow: Message[]
  oracleTermCount: number
  exactHandleTermCount: number
  futureToolArgTermCount: number
}

interface ScoredTerm {
  term: string
  normalized: string
  category: string
  weight: number
}

export const PROMPT_VARIANTS: PromptVariant[] = [
  {
    id: 'H01_BASELINE',
    title: '当前基线 prompt',
    hypothesis: '不额外补强，用当前生产 prompt 作为对照组。',
    instruction: '',
  },
  {
    id: 'H02_HANDLE_LEDGER',
    title: 'Handle Ledger',
    hypothesis: '显式要求在 parsed fields 里保留路径、URL、ID、文件名、变量和命令参数。',
    instruction: `<handle_preservation_rules>
你必须把“未来继续执行任务会直接用到的 handle”写入 topic 的 current_state 或 evidence item 中，不能只写“已生成文章/已创建视频/已同步资料”。
handle 包括：绝对路径、相对路径、URL、文件名、目录名、草稿/媒体 ID、commit/session/task id、变量名、函数名、类名、命令参数、模型名、配置 key。
如果一个 handle 来自 tool_use.input，请原样复制到 <current_state><item> 或 <evidence><item>，并标明对应 K 引用。
如果一个 handle 来自 tool_result 的摘要或 evidence path，请保留最短可执行形式，例如 path、basename、URL、id。
</handle_preservation_rules>`,
  },
  {
    id: 'H03_EXECUTABLE_RESUME',
    title: 'Executable Resume Card',
    hypothesis: '把压缩块当成交接卡，优先保留下一步工具能直接执行的参数。',
    instruction: `<executable_resume_rules>
把输出写给“下一轮要继续调用工具的 agent”，不是写给只聊天的读者。
每个 topic 的 current_state 至少包含 1 条“可执行交接项”：下一步可能读取/写入/上传/验证/同步的具体路径、URL、命令、脚本、产物名或配置 key。
如果没有明确 handle，写“无明确 handle，需要回看 Kx evidence path”，不要编造。
对 Obsidian 同步、公众号发布、视频/HTML/图片修复、workspace 清理这类任务，要优先保留最终产物路径和源素材路径。
</executable_resume_rules>`,
  },
  {
    id: 'H04_TOOL_ARG_ROUNDTRIP',
    title: 'Tool Argument Roundtrip',
    hypothesis: '要求覆盖所有 tool_use.input 中的关键参数，降低 future tool arg 丢失。',
    instruction: `<tool_argument_roundtrip>
对每个 K 引用，检查 input_preview 中是否有 path/url/file/id/command/model/key/name/title/query。
这些字段如果对后续行动有用，必须逐字出现在 topic summary/current_state/evidence 的至少一个 item 中。
不要只写“读取了文件”“运行了脚本”；要写“读取了 /path/file.md”“运行了 description=... 的 bash，关键参数为 ...”。
如果参数太多，保留最关键的 8-16 个，路径/URL/ID/文件名优先级最高。
</tool_argument_roundtrip>`,
  },
  {
    id: 'H05_ARTIFACT_FIRST',
    title: 'Artifact First',
    hypothesis: '先识别产物和资产，再归纳语义 topic。',
    instruction: `<artifact_first_rules>
在切 topic 前，先从 covered_messages/tool_index 中找所有产物：HTML、Markdown、图片、视频、音频、字幕、脚本、manifest、Obsidian 目录、公众号草稿、上传媒体。
凡是产物路径或产物文件名影响后续“同步/发布/修复/审核/清理”，都必须进入 current_state。
同一个产物跨多轮被修改时，保留最新版本，并在 summary 里说明旧版本与新版本关系。
如果只知道 evidence path，不知道最终产物路径，要把 evidence path 写入 evidence item 并标 needs_raw_review=true。
</artifact_first_rules>`,
  },
  {
    id: 'H06_ID_URL_PATH_STRICT',
    title: 'ID URL Path Strict',
    hypothesis: '用严格负约束防止模型把精确 handle 改写成泛化描述。',
    instruction: `<exact_handle_strict_rules>
禁止把 URL 改写为“相关链接”，禁止把路径改写为“共享目录/文章文件”，禁止把 id 改写为“草稿 ID/媒体 ID”。
如果原文有精确 URL/path/id/filename/command flag，输出里必须保留原字符串或 basename + 父目录二者之一。
不要翻译、缩写、纠正、补全、规范化路径或 URL；不能把大小写、下划线、连字符改掉。
变量名、函数名、类名、命令 flag 必须使用代码原样，例如 ImageMobject、ImageFont.truetype、-show_entries。
</exact_handle_strict_rules>`,
  },
  {
    id: 'H07_FUTURE_ACTION_MAP',
    title: 'Future Action Map',
    hypothesis: '按后续操作类型分类 handle，帮助同步/发布/修复任务。',
    instruction: `<future_action_map_rules>
每个 topic 的 next_actions 必须和 current_state 中的 handle 对应起来：下一步要读哪个文件、写哪个目录、验证哪个产物、上传哪个素材、调用哪个配置。
对可能的后续动作分类：
- read/inspect: 必须保留读取目标 path/url。
- write/sync/archive: 必须保留源路径和目标目录。
- publish/upload: 必须保留草稿 ID、media_id、文章路径、素材路径。
- fix/render: 必须保留脚本路径、输出文件、关键变量/函数/参数。
如果某个 next_action 缺少 handle，标注“handle_missing，需要回看 Kx”。
</future_action_map_rules>`,
  },
  {
    id: 'H08_TOPIC_HANDLE_INDEX',
    title: 'Topic Handle Index',
    hypothesis: '让每个 topic 自带 handle 索引，提高非连续 topic 的可执行性。',
    instruction: `<topic_handle_index_rules>
每个 topic 的 summary 先讲状态，再列出该 topic 的 handle index。
handle index 必须写入 parsed 字段中，可放在 current_state 或 evidence item，格式类似：
handle[path]=/Users/...
handle[url]=https://...
handle[file]=article.md
handle[var]=ImageMobject
handle[id]=draft_media_id:...
同一 handle 如果在多个 topic 使用，只保留在最相关 topic；跨 topic 依赖要在 summary 说明。
</topic_handle_index_rules>`,
  },
  {
    id: 'H09_HANDLE_EVIDENCE_PAIR',
    title: 'Handle Evidence Pair',
    hypothesis: '把精确 handle 和 K evidence 绑定，兼顾可执行与可审计。',
    instruction: `<handle_evidence_pair_rules>
所有重要 handle 都要尽量写成“handle + 来源 K ref + 为什么重要”。
示例：<item>K7 产物路径 /path/article.md，后续 Obsidian 同步需要读取它。</item>
示例：<item>K12 URL https://... 是正式发布链接，归档 article.md 时必须写入。</item>
如果工具结果很大，不能复制原文，但 evidence item 里仍要保留 path/url/id/basename 这些短 handle。
缺少来源的 handle 不要编造；写 needs_raw_review=true 并指出要回看哪个 K。
</handle_evidence_pair_rules>`,
  },
  {
    id: 'H10_DENSE_EXECUTABLE_STATE',
    title: 'Dense Executable State',
    hypothesis: '在不大幅变长的前提下，用密集交接状态保存语义和 exact handles。',
    instruction: `<dense_executable_state_rules>
输出要短，但不能牺牲可执行 handle。优先级：
1. 用户明确约束和纠正；
2. 最新产物路径/URL/ID/文件名；
3. 后续工具参数会复用的变量名、函数名、命令参数、配置 key；
4. 关键结论和 blocker；
5. 其他背景。
每个 topic 的 current_state 最多 8 条，但其中至少一半应是可执行状态或 exact handle，除非该 topic 没有工具调用。
把泛化句“素材已生成/已同步/已检查”替换成“素材 X 位于 path，检查结论 Y，后续 Z”。
</dense_executable_state_rules>`,
  },
]

export function parsePromptBenchmarkArgs(argv: string[]): PromptBenchmarkOptions {
  const cwd = process.cwd()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const options: PromptBenchmarkOptions = {
    dbPath: join(cwd, '.zero', 'logs', 'sessions.db'),
    outDir: join(cwd, 'benchmarks', 'zero-runtime', 'results', `compaction-prompt-${timestamp}`),
    sessionLimit: 10,
    reps: 3,
    concurrency: 3,
    model: 'deepseek-v4-flash',
    secretSource: 'vault',
    maxTokens: 8192,
    keepArtifacts: false,
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
      options.sessionIds = next
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      index++
    } else if (arg === '--limit' && next) {
      options.sessionLimit = positiveInt(next, options.sessionLimit)
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
    } else if (arg === '--max-tokens' && next) {
      options.maxTokens = positiveInt(next, options.maxTokens)
      index++
    } else if (arg === '--variants' && next) {
      options.variants = next
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      index++
    } else if (arg === '--keep-artifacts') {
      options.keepArtifacts = true
    } else if (arg === '--help' || arg === '-h') {
      printPromptBenchmarkHelp()
      process.exit(0)
    }
  }

  return options
}

export function printPromptBenchmarkHelp(): void {
  console.log(`Usage: bun run compaction:prompt-bench [options]

Options:
  --db <path>               sessions.db path (default .zero/logs/sessions.db)
  --out <dir>               output directory
  --sessions <ids>          comma-separated session ids; defaults to top sessions by JSON size
  --limit <n>               number of long sessions (default 10)
  --reps <n>                runs per session/variant (default 3)
  --concurrency <n>         concurrent API calls (default 3)
  --model <id>              official DeepSeek model id (default deepseek-v4-flash)
  --secret-source <vault|env>  read deepseek_api_key from vault or env (default vault)
  --variants <ids>          comma-separated variant ids
  --max-tokens <n>          max output tokens per call (default 8192)
  --keep-artifacts          keep temporary evidence artifacts
`)
}

export async function runPromptBenchmark(
  options: PromptBenchmarkOptions,
): Promise<PromptBenchmarkReport> {
  const variants = selectVariants(options.variants)
  const db = new Database(options.dbPath, { readonly: true })
  const workDir = mkdtempSync(join(tmpdir(), 'zero-compaction-prompt-bench-'))
  try {
    const rows = loadSessionRows(db, options)
    const samples = rows.map((row) => buildPromptBenchmarkSample(row, workDir))
    const adapter = await createDeepSeekAdapter(options)
    mkdirSync(options.outDir, { recursive: true })
    writeFileSync(
      join(options.outDir, 'samples.json'),
      JSON.stringify(redactSamples(samples), null, 2),
    )
    writeFileSync(join(options.outDir, 'prompt-variants.md'), renderPromptVariants(variants))

    const tasks: Array<() => Promise<PromptBenchmarkRunResult>> = []
    for (const sample of samples) {
      for (const variant of variants) {
        for (let rep = 1; rep <= options.reps; rep++) {
          tasks.push(() => runPromptVariant({ sample, variant, rep, adapter, options }))
        }
      }
    }

    const resultsPath = join(options.outDir, 'runs.jsonl')
    const results = await runWithConcurrency(tasks, options.concurrency, (result) => {
      appendFileSync(resultsPath, `${JSON.stringify(result)}\n`, 'utf-8')
      console.log(
        `[compaction-prompt] ${result.variantId} rep=${result.rep} session=${result.sessionId} score=${formatMaybe(result.compactScore)} exact=${formatMaybe(result.exactHandleScore)} loss=${formatMaybe(result.accuracyLossPercent)} parse=${result.parseOk ? 'ok' : 'fail'}`,
      )
    })

    const report: PromptBenchmarkReport = {
      generatedAt: new Date().toISOString(),
      dbPath: options.dbPath,
      model: options.model,
      options: {
        sessionLimit: options.sessionLimit,
        reps: options.reps,
        concurrency: options.concurrency,
        maxTokens: options.maxTokens,
      },
      variants,
      samples: redactSamples(samples),
      summaries: summarizeVariants(variants, results),
      results,
    }
    writeFileSync(join(options.outDir, 'summary.json'), JSON.stringify(report, null, 2), 'utf-8')
    writeFileSync(join(options.outDir, 'report.md'), renderPromptBenchmarkMarkdown(report), 'utf-8')
    return report
  } finally {
    db.close()
    if (!options.keepArtifacts) rmSync(workDir, { recursive: true, force: true })
  }
}

function buildPromptBenchmarkSample(row: SessionRow, workDir: string): PromptBenchmarkSample {
  const messages = parseMessages(row.messagesJson)
  const candidate = selectCandidateSample(messages)
  const currentGoal = extractCurrentGoal(candidate.prefixMessages)
  const episode = buildEpisodeCompaction(candidate.segment, { workDir, sessionId: row.sessionId })
  const coveredIds = new Set(candidate.segment.map((message) => message.id))
  const retainedMessages = candidate.prefixMessages.filter((message) => !coveredIds.has(message.id))
  const workingStateSummary = formatWorkingState(
    buildWorkingStateCompaction({
      currentGoal,
      retainedMessages,
      episodes: [episode],
    }),
  )
  return {
    sessionId: row.sessionId,
    messageCount: row.messageCount,
    messageJsonChars: row.messageJsonChars,
    checkpointTurnOrdinal: candidate.turnOrdinal,
    prefixMessageCount: candidate.prefixMessages.length,
    segmentMessageCount: candidate.segment.length,
    retainedMessageCount: retainedMessages.length,
    segmentToolUseCount: countToolUses(candidate.segment),
    oracleTermCount: candidate.oracleTermCount,
    exactHandleTermCount: candidate.exactHandleTermCount,
    futureToolArgTermCount: candidate.futureToolArgTermCount,
    nextUserPreview: preview(extractUserText(candidate.futureWindow[0]), 160),
    input: {
      sessionId: row.sessionId,
      blockId: `prompt_bench_${hashish(row.sessionId, candidate.turnOrdinal)}`,
      strategyVersion: 'prompt_benchmark_current_base_v1',
      currentGoal,
      segment: candidate.segment,
      retainedMessages,
      episode,
      workingStateSummary,
    },
    prefixMessages: candidate.prefixMessages,
    retainedMessages,
    futureWindow: candidate.futureWindow,
  }
}

async function runPromptVariant(params: {
  sample: PromptBenchmarkSample
  variant: PromptVariant
  rep: number
  adapter: ProviderAdapter
  options: PromptBenchmarkOptions
}): Promise<PromptBenchmarkRunResult> {
  const prompt = applyPromptVariant(
    buildContextCompactionPrompt(params.sample.input),
    params.variant,
  )
  const startedAt = Date.now()
  try {
    const response = await completeWithRetry(
      params.adapter,
      {
        messages: [
          {
            id: `prompt_bench_${params.sample.sessionId}_${params.variant.id}_${params.rep}`,
            sessionId: params.sample.sessionId,
            role: 'user',
            messageType: 'message',
            content: [{ type: 'text', text: prompt }],
            createdAt: new Date().toISOString(),
          },
        ],
        system: CONTEXT_COMPACTION_SYSTEM_PROMPT,
        stream: false,
        maxTokens: params.options.maxTokens,
        reasoningEffort: 'low',
        meta: {
          sessionId: params.sample.sessionId,
          purpose: 'compaction_prompt_benchmark',
        },
      },
      2,
    )
    const durationMs = Date.now() - startedAt
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
    const parsed = parseContextCompactionModelOutput(text, params.sample.input)
    return scoreRun({
      sample: params.sample,
      variant: params.variant,
      rep: params.rep,
      model: response.model || params.options.model,
      parsed,
      responseText: text,
      promptChars: prompt.length,
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
      durationMs,
    })
  } catch (error) {
    return {
      variantId: params.variant.id,
      variantTitle: params.variant.title,
      rep: params.rep,
      sessionId: params.sample.sessionId,
      model: params.options.model,
      parseOk: false,
      topicCount: 0,
      missingToolRefCount: params.sample.input.episode.toolUseIds.length,
      compactScore: 0,
      accuracyLossPercent: 100,
      exactHandleScore: 0,
      futureToolArgScore: 0,
      oracleTermCount: params.sample.oracleTermCount,
      exactHandleTermCount: params.sample.exactHandleTermCount,
      futureToolArgTermCount: params.sample.futureToolArgTermCount,
      missingExamples: [],
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - startedAt,
      promptChars: prompt.length,
      responseChars: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function scoreRun(params: {
  sample: PromptBenchmarkSample
  variant: PromptVariant
  rep: number
  model: string
  parsed: ContextCompactionModelOutput | undefined
  responseText: string
  promptChars: number
  inputTokens: number
  outputTokens: number
  durationMs: number
}): PromptBenchmarkRunResult {
  const projectionText = params.parsed
    ? renderParsedOutputForReplay(params.parsed)
    : params.responseText
  const compactedMessages = [
    ...params.sample.retainedMessages,
    syntheticMessage(params.sample.sessionId, projectionText),
  ]
  const scored = scoreCompactedContext({
    prefixMessages: params.sample.prefixMessages,
    compactedMessages,
    futureWindow: params.sample.futureWindow,
  })
  const compactScore = scored.compact.score
  const baselineScore = scored.baseline.score
  const exactHandleTerms = scored.terms.filter(isExactHandleTerm)
  const futureToolArgTerms = scored.terms.filter((term) => term.category === 'future_tool_arg')
  const compactCorpus = normalizeForMatch(
    compactedMessages.map((message) => messageToSignalText(message)).join('\n'),
  )
  const exactHandleScore = scoreSubsetTerms(exactHandleTerms, compactCorpus)
  const futureToolArgScore = scoreSubsetTerms(futureToolArgTerms, compactCorpus)
  const accuracyLossPercent =
    baselineScore === null || compactScore === null
      ? null
      : roundOne(Math.max(0, baselineScore - compactScore))
  return {
    variantId: params.variant.id,
    variantTitle: params.variant.title,
    rep: params.rep,
    sessionId: params.sample.sessionId,
    model: params.model,
    parseOk: Boolean(params.parsed),
    validationStatus: params.parsed?.validation?.status,
    topicCount: params.parsed?.topics?.length ?? 0,
    missingToolRefCount:
      params.parsed?.validation?.missingToolRefs.length ??
      params.sample.input.episode.toolUseIds.length,
    compactScore,
    accuracyLossPercent,
    exactHandleScore,
    futureToolArgScore,
    oracleTermCount: scored.terms.length,
    exactHandleTermCount: exactHandleTerms.length,
    futureToolArgTermCount: futureToolArgTerms.length,
    missingExamples: scored.compact.missingTerms.slice(0, 8).map((term) => term.term),
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    durationMs: params.durationMs,
    promptChars: params.promptChars,
    responseChars: params.responseText.length,
  }
}

function summarizeVariants(
  variants: PromptVariant[],
  results: PromptBenchmarkRunResult[],
): PromptVariantSummary[] {
  return variants.map((variant) => {
    const items = results.filter((result) => result.variantId === variant.id)
    return {
      variantId: variant.id,
      title: variant.title,
      hypothesis: variant.hypothesis,
      runCount: items.length,
      parseRate: percent(items.filter((item) => item.parseOk).length, items.length),
      validationPassRate: percent(
        items.filter((item) => item.validationStatus === 'passed').length,
        items.length,
      ),
      avgCompactScore: nullableAvg(items.map((item) => item.compactScore)),
      avgAccuracyLossPercent: nullableAvg(items.map((item) => item.accuracyLossPercent)),
      avgExactHandleScore: nullableAvg(items.map((item) => item.exactHandleScore)),
      avgFutureToolArgScore: nullableAvg(items.map((item) => item.futureToolArgScore)),
      avgMissingToolRefCount: avg(items.map((item) => item.missingToolRefCount)),
      avgInputTokens: avg(items.map((item) => item.inputTokens)),
      avgOutputTokens: avg(items.map((item) => item.outputTokens)),
      stabilityStddev: stddev(
        items.map((item) => item.compactScore).filter((item): item is number => item !== null),
      ),
    }
  })
}

export function renderPromptBenchmarkMarkdown(report: PromptBenchmarkReport): string {
  const ranked = [...report.summaries].sort(compareVariantSummary)
  return [
    '# Compaction Prompt Benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    `Model: \`${report.model}\``,
    `Runs: ${report.results.length} (${report.samples.length} sessions x ${report.variants.length} variants x ${report.options.reps} reps)`,
    '',
    '## Variant Summary',
    '',
    '| rank | variant | parse | validation | compact score | loss | exact handles | future tool args | missing K | stability |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...ranked.map((summary, index) =>
      markdownRow([
        index + 1,
        `\`${summary.variantId}\` ${escapeMarkdown(summary.title)}`,
        formatPercent(summary.parseRate),
        formatPercent(summary.validationPassRate),
        formatMaybe(summary.avgCompactScore),
        formatMaybe(summary.avgAccuracyLossPercent),
        formatMaybe(summary.avgExactHandleScore),
        formatMaybe(summary.avgFutureToolArgScore),
        summary.avgMissingToolRefCount.toFixed(1),
        formatMaybe(summary.stabilityStddev),
      ]),
    ),
    '',
    '## Session Samples',
    '',
    '| session | raw MB | turn | segment msgs | tools | oracle terms | exact handles | future tool args | next user |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...report.samples.map((sample) =>
      markdownRow([
        `\`${sample.sessionId}\``,
        (sample.messageJsonChars / 1024 / 1024).toFixed(1),
        sample.checkpointTurnOrdinal,
        sample.segmentMessageCount,
        sample.segmentToolUseCount,
        sample.oracleTermCount,
        sample.exactHandleTermCount,
        sample.futureToolArgTermCount,
        escapeMarkdown(sample.nextUserPreview),
      ]),
    ),
    '',
    '## Worst Remaining Runs',
    '',
    '| variant | session | rep | score | exact | future args | missing examples |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...[...report.results]
      .sort((left, right) => (left.compactScore ?? -1) - (right.compactScore ?? -1))
      .slice(0, 20)
      .map((result) =>
        markdownRow([
          `\`${result.variantId}\``,
          `\`${result.sessionId}\``,
          result.rep,
          formatMaybe(result.compactScore),
          formatMaybe(result.exactHandleScore),
          formatMaybe(result.futureToolArgScore),
          result.missingExamples.map((item) => `\`${escapeMarkdown(item)}\``).join(', ') || '-',
        ]),
      ),
    '',
  ].join('\n')
}

function renderPromptVariants(variants: PromptVariant[]): string {
  return [
    '# Prompt Variants',
    '',
    '每个版本都以当前 `buildContextCompactionPrompt()` 生成的生产 prompt 为基础，只在 `<instruction>` 内追加以下中文规则。',
    '',
    ...variants.flatMap((variant) => [
      `## ${variant.id} ${variant.title}`,
      '',
      `Hypothesis: ${variant.hypothesis}`,
      '',
      '```xml',
      variant.instruction || '<!-- baseline: no extra instruction -->',
      '```',
      '',
    ]),
  ].join('\n')
}

function compareVariantSummary(left: PromptVariantSummary, right: PromptVariantSummary): number {
  return (
    (right.avgExactHandleScore ?? -1) - (left.avgExactHandleScore ?? -1) ||
    (right.avgFutureToolArgScore ?? -1) - (left.avgFutureToolArgScore ?? -1) ||
    (right.avgCompactScore ?? -1) - (left.avgCompactScore ?? -1) ||
    (left.avgAccuracyLossPercent ?? 101) - (right.avgAccuracyLossPercent ?? 101)
  )
}

function selectCandidateSample(messages: Message[]): CandidateSample {
  const turnStarts = findTurnStarts(messages)
  const candidates = turnStarts
    .map((messageIndex, turnOrdinal) => ({
      messageIndex,
      turnOrdinal,
      nextMessageIndex: turnStarts[turnOrdinal + 1] ?? messages.length,
    }))
    .filter((candidate) => candidate.messageIndex > 0)
    .filter((candidate) => !isSystemNotice(extractUserText(messages[candidate.messageIndex])))

  const scored = candidates
    .map((candidate) => buildCandidateSample(messages, candidate))
    .filter((candidate): candidate is CandidateSample => Boolean(candidate))
    .sort((left, right) => right.score - left.score)

  if (scored[0]) return scored[0]
  const fallbackPrefixEnd = Math.max(1, messages.length - 1)
  const prefixMessages = messages.slice(0, fallbackPrefixEnd)
  const segment = prefixMessages.slice(0, Math.max(1, Math.floor(prefixMessages.length * 0.7)))
  const retainedMessages = prefixMessages.filter(
    (message) => !new Set(segment.map((item) => item.id)).has(message.id),
  )
  return {
    turnOrdinal: 0,
    messageIndex: fallbackPrefixEnd,
    nextMessageIndex: messages.length,
    score: 0,
    prefixMessages,
    segment,
    retainedMessages,
    futureWindow: messages.slice(fallbackPrefixEnd),
    oracleTermCount: 0,
    exactHandleTermCount: 0,
    futureToolArgTermCount: 0,
  }
}

function buildCandidateSample(
  messages: Message[],
  candidate: { turnOrdinal: number; messageIndex: number; nextMessageIndex: number },
): CandidateSample | null {
  const prefixMessages = messages.slice(0, candidate.messageIndex)
  const futureWindow = messages.slice(candidate.messageIndex, candidate.nextMessageIndex)
  if (futureWindow.length === 0) return null
  const segment = selectSegmentForPromptBenchmark(prefixMessages)
  if (segment.length === 0 || !segment.some(hasToolIo)) return null
  const segmentIds = new Set(segment.map((message) => message.id))
  const retainedMessages = prefixMessages.filter((message) => !segmentIds.has(message.id))
  const scored = scoreCompactedContext({
    prefixMessages,
    compactedMessages: prefixMessages,
    futureWindow,
  })
  const terms = scored.terms as ScoredTerm[]
  const exactHandleTermCount = terms.filter(isExactHandleTerm).length
  const futureToolArgTermCount = terms.filter((term) => term.category === 'future_tool_arg').length
  const score =
    futureToolArgTermCount * 30 +
    exactHandleTermCount * 15 +
    terms.length +
    countToolUses(segment) * 2 +
    stableJsonLength(segment) / 100000
  return {
    ...candidate,
    score,
    prefixMessages,
    segment,
    retainedMessages,
    futureWindow,
    oracleTermCount: terms.length,
    exactHandleTermCount,
    futureToolArgTermCount,
  }
}

function selectSegmentForPromptBenchmark(prefixMessages: Message[]): Message[] {
  const turnStarts = findTurnStarts(prefixMessages)
  let endIndex =
    turnStarts.length > 3
      ? turnStarts[Math.max(0, turnStarts.length - 3)]
      : Math.max(1, Math.floor(prefixMessages.length * 0.65))
  let segment = prefixMessages.slice(0, endIndex)
  if (segment.some(hasToolIo)) return trimSegmentForPromptBudget(segment)

  const lastToolIndex = prefixMessages.findLastIndex(hasToolIo)
  if (lastToolIndex >= 0) {
    endIndex = Math.min(prefixMessages.length, lastToolIndex + 1)
    segment = prefixMessages.slice(0, endIndex)
  }
  return trimSegmentForPromptBudget(segment)
}

function trimSegmentForPromptBudget(segment: Message[]): Message[] {
  const maxChars = 420000
  if (stableJsonLength(segment) <= maxChars) return segment
  const toolIndexes = segment
    .map((message, index) => (hasToolIo(message) ? index : -1))
    .filter((index) => index >= 0)
  if (toolIndexes.length === 0) return segment.slice(0, 80)
  const first = Math.max(0, toolIndexes[0] - 4)
  const lastToolIndex = toolIndexes[toolIndexes.length - 1] ?? segment.length - 1
  const last = Math.min(segment.length, lastToolIndex + 5)
  const sliced = segment.slice(first, last)
  if (stableJsonLength(sliced) <= maxChars) return sliced
  return sliced.slice(0, 120)
}

function applyPromptVariant(basePrompt: string, variant: PromptVariant): string {
  if (!variant.instruction.trim()) return basePrompt
  return basePrompt.replace(
    '</instruction>',
    `${variant.instruction}

<benchmark_note>
本 benchmark 特别关注：压缩后是否仍保留后续工具调用需要的产物路径、URL、文件名、变量、函数、命令参数、ID。
请把这些信息写入已有 parsed 字段，尤其是 topic/current_state/evidence/confirmed_facts/next_actions；不要只写在未定义的新标签里。
</benchmark_note>
</instruction>`,
  )
}

async function createDeepSeekAdapter(options: PromptBenchmarkOptions): Promise<ProviderAdapter> {
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
      tags: ['compaction', 'benchmark'],
    },
  })
}

async function loadDeepSeekApiKey(options: PromptBenchmarkOptions): Promise<string> {
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

function loadSessionRows(db: Database, options: PromptBenchmarkOptions): SessionRow[] {
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
      const row = statement.get(sessionId) as SessionRow | null
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
    .all({ $limit: options.sessionLimit }) as SessionRow[]
}

function selectVariants(ids: string[] | undefined): PromptVariant[] {
  if (!ids || ids.length === 0) return PROMPT_VARIANTS
  const wanted = new Set(ids)
  return PROMPT_VARIANTS.filter((variant) => wanted.has(variant.id))
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

function renderParsedOutputForReplay(output: ContextCompactionModelOutput): string {
  return [
    output.summary,
    ...(output.topics ?? []).flatMap((topic) => [
      topic.title,
      topic.summary,
      ...(topic.confirmedFacts ?? []),
      ...(topic.decisions ?? []),
      ...(topic.currentState ?? []),
      ...(topic.openQuestions ?? []),
      ...(topic.nextActions ?? []),
      ...(topic.evidence ?? []),
    ]),
    ...(output.confirmedFacts ?? []),
    ...(output.userConstraints ?? []),
    ...(output.decisions ?? []),
    ...(output.currentState ?? []),
    ...(output.openQuestions ?? []),
    ...(output.nextActions ?? []),
    ...(output.keyEvidence ?? []),
    ...(output.doNotInfer ?? []),
  ]
    .filter(Boolean)
    .join('\n')
}

function syntheticMessage(sessionId: string, text: string): Message {
  return {
    id: `synthetic_compaction_${hashish(sessionId, text.length)}`,
    sessionId,
    role: 'user',
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: new Date().toISOString(),
  }
}

function scoreSubsetTerms(terms: ScoredTerm[], normalizedCorpus: string): number | null {
  if (terms.length === 0) return null
  let hit = 0
  let total = 0
  for (const term of terms) {
    total += term.weight
    if (normalizedCorpus.includes(term.normalized)) hit += term.weight
  }
  return total > 0 ? roundOne((hit / total) * 100) : null
}

function isExactHandleTerm(term: ScoredTerm): boolean {
  return isExactHandleValue(term.term)
}

function isExactHandleValue(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) ||
    /^(?:\/Users|\.zero|\.\/|\/tmp|\/private)\//.test(value) ||
    /\.[A-Za-z0-9]{1,8}$/.test(value) ||
    /[-_][A-Za-z0-9_-]{2,}/.test(value) ||
    /[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*/.test(value)
  )
}

function messageToSignalText(message: Message): string {
  return message.content.map(blockToSignalText).join('\n')
}

function blockToSignalText(block: ContentBlock): string {
  if (block.type === 'text') return block.text
  if (block.type === 'tool_use') return `tool_use ${block.name} ${JSON.stringify(block.input)}`
  if (block.type === 'tool_result') return `${block.outputSummary ?? ''}\n${block.content}`
  if (block.type === 'image') return `${block.mediaType} ${block.imageRef?.path ?? ''}`
  if (block.type === 'thinking') return block.thinking
  return ''
}

function redactSamples(samples: PromptBenchmarkSample[]) {
  return samples.map(
    ({
      input: _input,
      prefixMessages: _prefix,
      retainedMessages: _retained,
      futureWindow: _future,
      ...sample
    }) => sample,
  )
}

function findTurnStarts(messages: Message[]): number[] {
  const starts: number[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (
      message.role === 'user' &&
      message.messageType === 'message' &&
      message.content.some((block) => block.type === 'text' && block.text.trim().length > 0)
    ) {
      starts.push(index)
    }
  }
  return starts
}

function extractCurrentGoal(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = extractUserText(messages[index])
    if (text.trim().length > 0 && !isSystemNotice(text)) return preview(text, 240)
  }
  return 'Continue the current session task.'
}

function extractUserText(message: Message | undefined): string {
  if (!message) return ''
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function hasToolIo(message: Message): boolean {
  return message.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result')
}

function countToolUses(messages: Message[]): number {
  return messages.reduce(
    (sum, message) => sum + message.content.filter((block) => block.type === 'tool_use').length,
    0,
  )
}

function isSystemNotice(text: string): boolean {
  return text.includes('<system_notice>') || text.includes('<system-reminder>')
}

function stableJsonLength(value: unknown): number {
  return JSON.stringify(value).length
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function preview(value: string | undefined, maxChars: number): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`
}

function avg(values: number[]): number {
  if (values.length === 0) return 0
  return roundOne(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function nullableAvg(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length > 0 ? avg(present) : null
}

function stddev(values: number[]): number | null {
  if (values.length < 2) return null
  const mean = avg(values)
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return roundOne(Math.sqrt(variance))
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
