#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

type TraceStatus = 'running' | 'success' | 'error'
type TraceKind =
  | 'turn'
  | 'llm_request'
  | 'tool_call'
  | 'context_compaction'
  | 'sub_agent'
  | 'snapshot'
  | 'closure_decision'
  | 'closure_failed'

interface TraceEntry {
  spanId: string
  parentSpanId?: string
  sessionId: string
  kind: TraceKind
  name: string
  agentName?: string
  startTime: string
  endTime?: string
  durationMs?: number
  status: TraceStatus
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

interface ToolEvent {
  toolName: string
  status: TraceStatus
  outputSummary?: string
}

type TaskCluster =
  | 'web_research'
  | 'code_or_repo_work'
  | 'file_data_work'
  | 'browser_automation'
  | 'memory_maintenance'
  | 'image_or_media'
  | 'scheduling_or_ops'
  | 'general_agent_work'

interface CaseRecord {
  sessionId: string
  turnSpanId: string
  turnIndex?: number
  status: 'success' | 'error'
  prompt: string
  toolEvents: ToolEvent[]
  failureSignals: string[]
  cluster: TaskCluster
}

type PatchKind = 'success_pattern' | 'failure_guardrail'
type PatchCategory =
  | 'filesystem'
  | 'web_access'
  | 'browser'
  | 'command_execution'
  | 'memory_workflow'
  | 'runtime_hygiene'
  | 'general_workflow'

interface PatchCandidate {
  kind: PatchKind
  cluster: TaskCluster | 'all'
  category: PatchCategory
  title: string
  support: number
  confidence: 'low' | 'medium' | 'high'
  recommendation: string
  evidence: string[]
}

interface SuppressedPattern {
  reason: string
  title: string
  support: number
  evidence: string[]
}

interface CliOptions {
  logsDir: string
  output: string
  minSupport: number
  limit: number
  maxEvidence: number
  includePrompts: boolean
  includeRuntimeNoise: boolean
  skillOutput?: string
}

const DEFAULT_OPTIONS: CliOptions = {
  logsDir: '.zero/logs',
  output: '.zero/workspace/shared/trace2skill-draft.md',
  minSupport: 3,
  limit: 80,
  maxEvidence: 5,
  includePrompts: false,
  includeRuntimeNoise: false,
}

function parseArgs(argv: string[]): CliOptions {
  const options = { ...DEFAULT_OPTIONS }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--logs-dir' && next) {
      options.logsDir = next
      index += 1
    } else if (arg === '--output' && next) {
      options.output = next
      index += 1
    } else if (arg === '--min-support' && next) {
      options.minSupport = Number.parseInt(next, 10)
      index += 1
    } else if (arg === '--limit' && next) {
      options.limit = Number.parseInt(next, 10)
      index += 1
    } else if (arg === '--max-evidence' && next) {
      options.maxEvidence = Number.parseInt(next, 10)
      index += 1
    } else if (arg === '--skill-output' && next) {
      options.skillOutput = next
      index += 1
    } else if (arg === '--include-prompts') {
      options.includePrompts = true
    } else if (arg === '--include-runtime-noise') {
      options.includeRuntimeNoise = true
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit()
    }
  }
  for (const key of ['minSupport', 'limit', 'maxEvidence'] as const) {
    if (!Number.isFinite(options[key]) || options[key] < 1) {
      throw new Error(`--${key} must be a positive integer`)
    }
  }
  return options
}

function printHelpAndExit(): never {
  console.log(`Usage: bun run benchmarks/zero-runtime/trace2skill-miner.ts [options]

Benchmark-only Trace2Skill-style miner for ZeRo trace.jsonl files.
It does not modify runtime code or installed skills.

Options:
  --logs-dir <dir>          Logs root containing sessions/**/trace.jsonl (default: .zero/logs)
  --output <file>           Markdown draft output path (default: .zero/workspace/shared/trace2skill-draft.md)
  --min-support <n>         Minimum recurring support for a patch candidate (default: 3)
  --limit <n>               Max newest trace.jsonl files to mine (default: 80)
  --max-evidence <n>        Max evidence bullets per patch (default: 5)
  --skill-output <file>     Optional compact SKILL.md-style draft output
  --include-prompts         Include sanitized user prompts in evidence (off by default)
  --include-runtime-noise   Keep runtime/system noise in main candidates (off by default)
`)
  process.exit(0)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function redactTraceText(value: string): string {
  return value
    .replace(/<system_notice>[\s\S]*?(?:<\/system_notice>|$)/gi, '<system_notice>')
    .replace(/\[System\][\s\S]*?context\./gi, '[System restart notice]')
    .replace(/<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/gi, '<system-reminder>')
    .replace(/\/Users\/[^\s,，)）]+/g, '<local-path>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/\b\d{4,}\b/g, '<number>')
    .replace(/(密码|口令|password|passcode|token|api[_-]?key)(分别是|是|:|：)?\s*[^\s,，。;；]+/gi, '$1$2 <redacted>')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>')
}

function compactText(value: string | undefined, maxLength = 220): string | undefined {
  if (!value) return undefined
  const compacted = redactTraceText(value).replace(/\s+/g, ' ').trim()
  if (!compacted || compacted === '<system_notice>' || compacted === '<system-reminder>') return undefined
  if (compacted.length <= maxLength) return compacted
  return `${compacted.slice(0, Math.max(0, maxLength - 1))}…`
}

function normalizeError(value: string | undefined): string {
  return compactText(value, 180)
    ?.replace(/span_[\w-]+/g, 'span_*')
    .replace(/sess_[\w-]+/g, 'sess_*')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'unknown error'
}

function confidence(support: number): PatchCandidate['confidence'] {
  if (support >= 5) return 'high'
  if (support >= 2) return 'medium'
  return 'low'
}

function collectTraceFiles(root: string, limit: number): string[] {
  const files: Array<{ path: string; mtimeMs: number }> = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || !existsSync(current)) continue
    const stats = statSync(current)
    if (stats.isFile()) {
      if (basename(current) === 'trace.jsonl') files.push({ path: current, mtimeMs: stats.mtimeMs })
      continue
    }
    if (stats.isDirectory()) {
      for (const child of readdirSync(current)) stack.push(join(current, child))
    }
  }
  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((item) => item.path)
}

function readTraceJsonl(path: string): TraceEntry[] {
  const latest = new Map<string, TraceEntry>()
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry = JSON.parse(trimmed) as TraceEntry
      latest.set(`${entry.sessionId}:${entry.spanId}`, entry)
    } catch {}
  }
  return [...latest.values()].sort((left, right) => left.startTime.localeCompare(right.startTime))
}

function buildChildren(entries: TraceEntry[]): Map<string, TraceEntry[]> {
  const children = new Map<string, TraceEntry[]>()
  for (const entry of entries) {
    if (!entry.parentSpanId) continue
    const list = children.get(entry.parentSpanId) ?? []
    list.push(entry)
    children.set(entry.parentSpanId, list)
  }
  return children
}

function descendants(root: TraceEntry, children: Map<string, TraceEntry[]>): TraceEntry[] {
  const out: TraceEntry[] = []
  const queue = [...(children.get(root.spanId) ?? [])]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    out.push(current)
    queue.push(...(children.get(current.spanId) ?? []))
  }
  return out.sort((left, right) => left.startTime.localeCompare(right.startTime))
}

function classifyTaskCluster(prompt: string, toolEvents: ToolEvent[]): TaskCluster {
  const lower = prompt.toLowerCase()
  const tools = new Set(toolEvents.map((event) => event.toolName))
  const nonMemoryTools = toolEvents.filter(
    (event) => event.toolName !== 'memory' && event.toolName !== 'memory_search' && event.toolName !== 'memory_read',
  )

  if (/公众号|图片|图像|配图|视频|音频|tts|manim|封面|svg|artifact/.test(lower)) {
    return 'image_or_media'
  }
  if (/代码|仓库|repo|commit|typescript|python|bug|测试|实现|重构|修复|package|tsc|bun test|源码/.test(lower)) {
    return 'code_or_repo_work'
  }
  if (/论文|文章|x\.com|twitter|github|研究|搜索|调查|查一下|http|网页内容|引用|评论/.test(lower)) {
    return 'web_research'
  }
  if (/browser|浏览器|网页|dom|截图|登录态|打开.*页面|预览链接/.test(lower)) {
    return 'browser_automation'
  }
  if (/excel|xlsx|csv|jsonl|文件|下载|epub|pdf|表格|数据|目录|路径|读取|压缩包|rar|zip/.test(lower)) {
    return 'file_data_work'
  }
  if (/定时|每天|cron|部署|服务|启动|服务器|ssh|运维/.test(lower) || tools.has('schedule')) {
    return 'scheduling_or_ops'
  }
  if (/memory|记忆|回忆|记住|长期|session 类型的记忆|当前会话即将结束/.test(lower) || nonMemoryTools.length === 0) {
    return 'memory_maintenance'
  }
  return 'general_agent_work'
}

function clusterLabel(cluster: TaskCluster | 'all'): string {
  return cluster
    .split('_')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

function extractCases(entries: TraceEntry[]): CaseRecord[] {
  const children = buildChildren(entries)
  const cases: CaseRecord[] = []
  for (const turn of entries.filter((entry) => entry.kind === 'turn')) {
    const spanEntries = descendants(turn, children)
    const requests = spanEntries
      .filter((entry) => entry.kind === 'llm_request')
      .map((entry) => asRecord(asRecord(entry.data)?.request))
    const firstRequest = requests.find((request) => asString(request?.userPrompt))
    const prompt = compactText(asString(firstRequest?.userPrompt))
    if (!prompt) continue

    const toolEvents: ToolEvent[] = spanEntries
      .filter((entry) => entry.kind === 'tool_call')
      .flatMap((entry) => {
        const data = asRecord(entry.data)
        const metadata = asRecord(entry.metadata)
        const toolName = asString(data?.tool) ?? asString(metadata?.toolName)
        if (!toolName) return []
        const result = asRecord(data?.toolResult) ?? asRecord(metadata?.toolResult)
        return [{ toolName, status: entry.status, outputSummary: compactText(asString(result?.outputSummary)) }]
      })

    const closureFailures = spanEntries.filter((entry) => entry.kind === 'closure_failed')
    const failureSignals = [
      ...toolEvents
        .filter((event) => event.status === 'error')
        .map((event) => `tool:${event.toolName}:${event.outputSummary ?? 'error'}`),
      ...closureFailures.map((entry) => {
        const closure = asRecord(asRecord(entry.data)?.closure)
        return `closure:${asString(closure?.reason) ?? entry.status}`
      }),
    ]

    const cluster = classifyTaskCluster(prompt, toolEvents)

    cases.push({
      sessionId: turn.sessionId,
      turnSpanId: turn.spanId,
      turnIndex: asNumber(asRecord(turn.data)?.turnIndex),
      status: turn.status === 'success' && failureSignals.length === 0 ? 'success' : 'error',
      prompt,
      toolEvents,
      failureSignals,
      cluster,
    })
  }
  return cases
}

function caseKey(item: CaseRecord): string {
  return item.turnIndex === undefined
    ? `${item.sessionId}:${item.turnSpanId}`
    : `${item.sessionId}:turn:${item.turnIndex}`
}

function uniqueCases(cases: CaseRecord[]): CaseRecord[] {
  const seen = new Set<string>()
  const out: CaseRecord[] = []
  for (const item of cases) {
    const key = caseKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function evidenceLine(item: CaseRecord, includePrompt: boolean): string {
  const locator = `${item.sessionId}#${item.turnIndex ?? item.turnSpanId}`
  return includePrompt ? `${locator}: ${item.prompt}` : locator
}

function isRuntimePrompt(prompt: string): boolean {
  return (
    prompt.includes('<system_notice>') ||
    prompt.includes('[System restart notice]') ||
    prompt.includes('当前会话即将结束') ||
    prompt.includes('Continue the interrupted task')
  )
}

function onlyMemoryWorkflow(chain: string): boolean {
  const tools = chain.split(' → ')
  return tools.every((tool) => tool === 'memory' || tool === 'memory_search' || tool === 'memory_read')
}

function classifyFailure(toolName: string | undefined, summary: string): {
  category: PatchCategory
  normalizedTitle: string
  recommendation: string
  suppress?: string
} {
  const lower = summary.toLowerCase()

  if (!toolName) {
    return {
      category: 'runtime_hygiene',
      normalizedTitle: 'Closure classifier produced invalid output',
      recommendation:
        'Keep closure-classifier errors out of domain skills. Track them as runtime hygiene unless they block user-visible task completion.',
      suppress: 'runtime closure noise',
    }
  }

  if (/tool input json was malformed|failed to parse tool input json|max_token/.test(lower)) {
    return {
      category: 'runtime_hygiene',
      normalizedTitle: 'Tool input JSON was malformed or truncated',
      recommendation:
        'Keep malformed tool-call JSON as model/runtime hygiene. For actionable prevention, shorten tool inputs, avoid huge inline payloads, and split large writes into files.',
      suppress: 'tool-call serialization/runtime noise',
    }
  }

  if (toolName === 'memory' && lower.includes('memory not found')) {
    return {
      category: 'memory_workflow',
      normalizedTitle: 'Memory update targeted a missing memory id',
      recommendation:
        'Before updating memory, search/list the target memory and verify the id still exists. If no match exists, create a new memory instead of updating a stale id.',
    }
  }

  if (toolName === 'codex' && /deprecated|exited with code/.test(lower)) {
    return {
      category: 'runtime_hygiene',
      normalizedTitle: 'Codex CLI invocation failed or used deprecated flags',
      recommendation:
        'Track Codex CLI invocation failures as tooling hygiene unless the trace shows a domain-specific repair pattern.',
      suppress: 'tooling/runtime noise',
    }
  }

  if (toolName === 'read' && lower.includes('file not found')) {
    return {
      category: 'filesystem',
      normalizedTitle: 'File path did not exist at read time',
      recommendation:
        'Before reading a user- or trace-derived path, resolve it relative to the repo/workspace and check existence. If missing, search nearby directories before asking the user.',
    }
  }

  if (toolName === 'bash' && /cd <local-path>|no such file|not a directory/.test(lower)) {
    return {
      category: 'filesystem',
      normalizedTitle: 'Bash command assumed an invalid working directory',
      recommendation:
        'Split `cd <path> && ...` commands: first verify the directory exists, then run the command from that directory. Do not retry the same combined command without diagnosing stderr.',
    }
  }

  if (toolName === 'bash' && /timeout|timed out|signal|killed/.test(lower)) {
    return {
      category: 'command_execution',
      normalizedTitle: 'Long-running shell command timed out or was interrupted',
      recommendation:
        'For long commands, set an explicit timeout, capture partial output, and resume from the last completed step instead of restarting the full pipeline blindly.',
    }
  }

  if (toolName === 'bash' && /command failed \(exit #\)/.test(lower)) {
    return {
      category: 'command_execution',
      normalizedTitle: 'Shell command failed with non-zero exit',
      recommendation:
        'Read stderr and classify the failure before retrying. Prefer smaller diagnostic commands over repeating the full command line.',
    }
  }

  if (toolName === 'fetch' && /timeout|unable to connect|fetch error/.test(lower)) {
    return {
      category: 'web_access',
      normalizedTitle: 'Fetch could not reach the URL reliably',
      recommendation:
        'When fetch cannot connect or times out, switch to a browser-rendered path or an alternate public/API source, and record which source succeeded.',
    }
  }

  if (toolName === 'fetch' && /http #/.test(lower)) {
    return {
      category: 'web_access',
      normalizedTitle: 'Fetch returned an abnormal HTTP response',
      recommendation:
        'Treat non-ideal HTTP responses as evidence to inspect, not automatic failure. Check status, body shape, and whether a JS/browser path is required before forming conclusions.',
    }
  }

  if (toolName === 'bash' && /agent-browser|browser/.test(lower)) {
    return {
      category: 'browser',
      normalizedTitle: 'Browser automation command failed from shell',
      recommendation:
        'Before shelling out to browser automation, confirm the browser tool/bridge is installed and the target URL can be opened. Prefer the browser skill/toolkit when login state or DOM extraction matters.',
    }
  }

  return {
    category: 'general_workflow',
    normalizedTitle: `${toolName} recurring failure: ${summary}`,
    recommendation:
      'Validate inputs and outputs around this recurring tool failure. If it changes state, add dry-run or read-back verification before declaring success.',
  }
}

function minePatches(cases: CaseRecord[], options: CliOptions): {
  patches: PatchCandidate[]
  suppressed: SuppressedPattern[]
} {
  const successChains = new Map<string, CaseRecord[]>()
  const failures = new Map<
    string,
    {
      toolName?: string
      summary: string
      category: PatchCategory
      recommendation: string
      suppress?: string
      cluster: TaskCluster | 'all'
      cases: CaseRecord[]
    }
  >()
  const suppressed: SuppressedPattern[] = []

  for (const item of cases) {
    if (item.status === 'success' && item.toolEvents.length > 0 && !isRuntimePrompt(item.prompt)) {
      const chain = item.toolEvents.map((event) => event.toolName).join(' → ')
      const list = successChains.get(chain) ?? []
      list.push(item)
      successChains.set(chain, list)
    }
    for (const event of item.toolEvents.filter((toolEvent) => toolEvent.status === 'error')) {
      const summary = normalizeError(event.outputSummary)
      const analysis = classifyFailure(event.toolName, summary)
      const key = `${item.cluster}:${analysis.category}:${analysis.normalizedTitle}`
      const group =
        failures.get(key) ??
        {
          toolName: event.toolName,
          summary: analysis.normalizedTitle,
          category: analysis.category,
          recommendation: analysis.recommendation,
          suppress: analysis.suppress,
          cluster: item.cluster,
          cases: [],
        }
      group.cases.push(item)
      failures.set(key, group)
    }
    for (const signal of item.failureSignals.filter((value) => value.startsWith('closure:'))) {
      const summary = normalizeError(signal)
      const analysis = classifyFailure(undefined, summary)
      const key = `${item.cluster}:${analysis.category}:${analysis.normalizedTitle}`
      const group =
        failures.get(key) ??
        {
          summary: analysis.normalizedTitle,
          category: analysis.category,
          recommendation: analysis.recommendation,
          suppress: analysis.suppress,
          cluster: item.cluster,
          cases: [],
        }
      group.cases.push(item)
      failures.set(key, group)
    }
  }

  const patches: PatchCandidate[] = []
  for (const [chain, groupedCases] of successChains) {
    const unique = uniqueCases(groupedCases)
    if (unique.length < options.minSupport) continue

    if (onlyMemoryWorkflow(chain) || chain.endsWith(' → memory')) {
      suppressed.push({
        reason: 'memory/session lifecycle workflow, not a domain skill',
        title: `Reusable tool chain: ${chain}`,
        support: unique.length,
        evidence: unique.slice(0, options.maxEvidence).map((item) => evidenceLine(item, options.includePrompts)),
      })
      continue
    }

    patches.push({
      kind: 'success_pattern',
      category: chain.includes('fetch') ? 'web_access' : chain.includes('bash') ? 'command_execution' : 'general_workflow',
      cluster: unique[0]?.cluster ?? 'all',
      title: `Reusable tool chain: ${chain}`,
      support: unique.length,
      confidence: confidence(unique.length),
      recommendation: `When a task matches this pattern, consider this proven tool sequence: ${chain}. Keep an explicit verification/read-back step before reporting completion.`,
      evidence: unique.slice(0, options.maxEvidence).map((item) => evidenceLine(item, options.includePrompts)),
    })
  }

  for (const group of failures.values()) {
    const unique = uniqueCases(group.cases)
    if (unique.length < options.minSupport) continue
    const title = group.toolName
      ? `Guardrail: ${group.summary}`
      : `Runtime hygiene: ${group.summary}`

    if (group.suppress && !options.includeRuntimeNoise) {
      suppressed.push({
        reason: group.suppress,
        title,
        support: unique.length,
        evidence: unique.slice(0, options.maxEvidence).map((item) => evidenceLine(item, options.includePrompts)),
      })
      continue
    }

    patches.push({
      kind: 'failure_guardrail',
      category: group.category,
      cluster: group.cluster,
      title,
      support: unique.length,
      confidence: confidence(unique.length),
      recommendation: group.recommendation,
      evidence: unique.slice(0, options.maxEvidence).map((item) => evidenceLine(item, options.includePrompts)),
    })
  }

  return {
    patches: patches.sort((left, right) => right.support - left.support || left.title.localeCompare(right.title)),
    suppressed: suppressed.sort((left, right) => right.support - left.support || left.title.localeCompare(right.title)),
  }
}

function renderSkillDraft(params: { patches: PatchCandidate[] }): string {
  const lines: string[] = []
  lines.push('---')
  lines.push('name: zero-trace-derived-agent-ops')
  lines.push('description: Benchmark-only compact SKILL.md draft distilled from recurring ZeRo trace patterns. Review before installing.')
  lines.push('---')
  lines.push('')
  lines.push('# ZeRo Trace-Derived Agent Operations')
  lines.push('')
  lines.push('> Draft generated by benchmark Trace2Skill miner. It contains only generalized SOPs; raw evidence remains in the benchmark report.')
  lines.push('')
  lines.push('## Universal Tool-Use Guardrails')
  lines.push('')
  lines.push('- After any tool failure, read the error output and classify the root cause before retrying. Do not repeat the same failing command blindly.')
  lines.push('- For state-changing work, add a read-back or verification step before reporting completion.')
  lines.push('- Keep runtime hygiene issues separate from domain skills: closure classifier failures, malformed tool-call JSON, and session-memory cleanup are not task-domain evidence.')
  lines.push('')

  const highSupport = params.patches.filter((patch) => patch.support >= 3)
  const categories: PatchCategory[] = [
    'filesystem',
    'command_execution',
    'web_access',
    'browser',
    'memory_workflow',
    'general_workflow',
  ]
  for (const category of categories) {
    const patches = highSupport.filter((patch) => patch.category === category)
    if (patches.length === 0) continue
    lines.push(`## ${category.split('_').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')}`)
    lines.push('')
    const seen = new Set<string>()
    for (const patch of patches) {
      if (seen.has(patch.recommendation)) continue
      seen.add(patch.recommendation)
      lines.push(`- ${patch.recommendation}`)
    }
    lines.push('')
  }

  lines.push('## Before Installing This Skill')
  lines.push('')
  lines.push('- Validate each rule against held-out traces.')
  lines.push('- Remove rules that only reflect temporary tooling bugs.')
  lines.push('- Split domain-specific rules into narrower skills when enough evidence exists.')
  lines.push('')
  return `${lines.join('\n')}\n`
}

function renderMarkdown(params: {
  traceFiles: number
  sessions: number
  cases: CaseRecord[]
  patches: PatchCandidate[]
  suppressed: SuppressedPattern[]
}): string {
  const lines: string[] = []
  lines.push('---')
  lines.push('name: trace-derived-zero-agent-skill-draft')
  lines.push('description: Benchmark-only draft mined from ZeRo trace.jsonl evidence. Review before installing.')
  lines.push('---')
  lines.push('')
  lines.push('# Trace-Derived ZeRo Agent Skill Draft')
  lines.push('')
  lines.push('> Benchmark-only experiment. This file is not an installed skill and was generated from sanitized trace evidence.')
  lines.push('')
  lines.push('## Evidence Summary')
  lines.push('')
  lines.push(`- Trace files: ${params.traceFiles}`)
  lines.push(`- Sessions: ${params.sessions}`)
  lines.push(`- Cases: ${params.cases.length}`)
  lines.push(`- Success cases: ${params.cases.filter((item) => item.status === 'success').length}`)
  lines.push(`- Error cases: ${params.cases.filter((item) => item.status === 'error').length}`)
  lines.push(`- Tool events: ${params.cases.reduce((sum, item) => sum + item.toolEvents.length, 0)}`)
  lines.push(`- Actionable patch candidates: ${params.patches.length}`)
  lines.push(`- Suppressed runtime/lifecycle patterns: ${params.suppressed.length}`)
  lines.push('')
  lines.push('## Cluster Summary')
  lines.push('')

  const clusterOrder: Array<TaskCluster | 'all'> = [
    'web_research',
    'code_or_repo_work',
    'file_data_work',
    'browser_automation',
    'memory_maintenance',
    'image_or_media',
    'scheduling_or_ops',
    'general_agent_work',
    'all',
  ]
  const caseClusters = new Map<TaskCluster, CaseRecord[]>()
  for (const item of params.cases) {
    const list = caseClusters.get(item.cluster) ?? []
    list.push(item)
    caseClusters.set(item.cluster, list)
  }
  for (const cluster of clusterOrder) {
    if (cluster === 'all') continue
    const list = caseClusters.get(cluster) ?? []
    if (list.length === 0) continue
    lines.push(
      `- ${clusterLabel(cluster)}: ${list.length} cases (${
        list.filter((item) => item.status === 'error').length
      } error)`,
    )
  }

  lines.push('')
  lines.push('## Actionable Patch Candidates by Cluster')
  lines.push('')

  for (const cluster of clusterOrder) {
    const patches = params.patches.filter((patch) => patch.cluster === cluster)
    if (patches.length === 0) continue
    lines.push(`### ${clusterLabel(cluster)}`)
    lines.push('')

    for (const patch of patches) {
      const icon = patch.kind === 'failure_guardrail' ? '⚠️' : '✅'
      lines.push(`#### ${icon} ${patch.title}`)
      lines.push('')
      lines.push(`- Kind: ${patch.kind}`)
      lines.push(`- Category: ${patch.category}`)
      lines.push(`- Support: ${patch.support}`)
      lines.push(`- Confidence: ${patch.confidence}`)
      lines.push(`- Recommendation: ${patch.recommendation}`)
      lines.push('- Evidence:')
      for (const evidence of patch.evidence) lines.push(`  - ${evidence}`)
      lines.push('')
    }
  }

  lines.push('## Suppressed Runtime / Lifecycle Patterns')
  lines.push('')
  if (params.suppressed.length === 0) {
    lines.push('- None')
  }
  for (const item of params.suppressed.slice(0, 20)) {
    lines.push(`### ${item.title}`)
    lines.push('')
    lines.push(`- Reason: ${item.reason}`)
    lines.push(`- Support: ${item.support}`)
    lines.push('- Evidence:')
    for (const evidence of item.evidence) lines.push(`  - ${evidence}`)
    lines.push('')
  }

  lines.push('## Review Checklist')
  lines.push('')
  lines.push('- Do not install automatically; manually review against raw traces first.')
  lines.push('- Keep runtime hygiene separate from domain skills.')
  lines.push('- Keep high-support SOPs in SKILL.md; route rare quirks to references/.')
  lines.push('- Validate on held-out sessions before enabling by default.')
  lines.push('')
  return `${lines.join('\n')}\n`
}

const options = parseArgs(process.argv.slice(2))
const logsDir = resolve(options.logsDir)
const output = resolve(options.output)
const traceFiles = collectTraceFiles(logsDir, options.limit)
if (traceFiles.length === 0) throw new Error(`No trace.jsonl files found under ${logsDir}`)

const cases = uniqueCases(traceFiles.flatMap((path) => extractCases(readTraceJsonl(path))))
const mined = minePatches(cases, options)
const sessions = new Set(cases.map((item) => item.sessionId)).size
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, renderMarkdown({ traceFiles: traceFiles.length, sessions, cases, ...mined }), 'utf-8')
if (options.skillOutput) {
  const skillOutput = resolve(options.skillOutput)
  mkdirSync(dirname(skillOutput), { recursive: true })
  writeFileSync(skillOutput, renderSkillDraft({ patches: mined.patches }), 'utf-8')
}

console.log(
  JSON.stringify(
    {
      output,
      traceFiles: traceFiles.length,
      sessions,
      cases: cases.length,
      patches: mined.patches.length,
      suppressed: mined.suppressed.length,
      skillOutput: options.skillOutput ? resolve(options.skillOutput) : undefined,
    },
    null,
    2,
  ),
)
