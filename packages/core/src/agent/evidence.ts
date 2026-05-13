import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  EpisodeCompaction,
  Message,
  ToolEvidence,
  ToolEvidenceKind,
  ToolResultBlock,
  ToolUseBlock,
  WorkingStateCompaction,
} from '@zero-os/shared'
import { now } from '@zero-os/shared'
import { CONTEXT_PARAMS } from './params'

interface EvidenceWriteInput {
  workDir: string
  sessionId: string
  toolUseId: string
  toolName: string
  kind: ToolEvidenceKind
  payload: string
  summary?: string
  strategy?: string
  extension?: 'json' | 'txt'
}

interface ToolObservation {
  toolUseId: string
  toolName: string
  input?: Record<string, unknown>
  inputEvidence?: ToolEvidence
  result?: ToolResultBlock
  resultEvidence?: ToolEvidence
}

interface EpisodeBuildOptions {
  workDir: string
  sessionId: string
}

const evidenceBaseDir = 'tool-evidence'

export function shouldPersistToolInput(input: Record<string, unknown>): boolean {
  return stableStringify(input).length > CONTEXT_PARAMS.toolOutput.artifactThresholdChars
}

export function persistToolEvidence(input: EvidenceWriteInput): ToolEvidence {
  const sha256 = createHash('sha256').update(input.payload).digest('hex')
  const safeTool = sanitizePathPart(input.toolName)
  const safeUseId = sanitizePathPart(input.toolUseId)
  const ext = input.extension ?? (input.kind === 'tool_use_input' ? 'json' : 'txt')
  const dir = join(input.workDir, '.artifacts', input.sessionId, evidenceBaseDir)
  mkdirSync(dir, { recursive: true })

  const filename = `${safeUseId}-${input.kind}-${safeTool}-${sha256.slice(0, 12)}.${ext}`
  const path = join(dir, filename)
  if (!existsSync(path)) {
    writeFileSync(path, input.payload, 'utf-8')
  }

  return {
    kind: input.kind,
    sessionId: input.sessionId,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    path,
    chars: input.payload.length,
    bytes: Buffer.byteLength(input.payload, 'utf-8'),
    sha256,
    createdAt: now(),
    summary: input.summary,
    strategy: input.strategy,
  }
}

export function persistToolInputEvidence(params: {
  workDir: string
  sessionId: string
  toolUse: ToolUseBlock
}): ToolEvidence {
  const payload = stableStringify(params.toolUse.input)
  const summary = summarizeToolInput(params.toolUse.name, params.toolUse.input)
  return persistToolEvidence({
    workDir: params.workDir,
    sessionId: params.sessionId,
    toolUseId: params.toolUse.id,
    toolName: params.toolUse.name,
    kind: 'tool_use_input',
    payload,
    summary: summary.summary,
    strategy: summary.strategy,
    extension: 'json',
  })
}

export function persistToolResultEvidence(params: {
  workDir: string
  sessionId: string
  toolUseId: string
  toolName: string
  content: string
  outputSummary?: string
}): ToolEvidence {
  const summary = summarizeToolResult(params.toolName, params.content, params.outputSummary)
  return persistToolEvidence({
    workDir: params.workDir,
    sessionId: params.sessionId,
    toolUseId: params.toolUseId,
    toolName: params.toolName,
    kind: 'tool_result_output',
    payload: params.content,
    summary,
    strategy: `${params.toolName.toLowerCase()}_result`,
    extension: 'txt',
  })
}

export function attachLargeToolUseEvidence(
  content: Message['content'],
  options: { workDir: string; sessionId: string },
): Message['content'] {
  return content.map((block) => {
    if (block.type !== 'tool_use') return block
    if (block.evidence || !shouldPersistToolInput(block.input)) return block
    return {
      ...block,
      evidence: persistToolInputEvidence({
        workDir: options.workDir,
        sessionId: options.sessionId,
        toolUse: block,
      }),
    }
  })
}

export function buildEpisodeCompaction(
  messages: Message[],
  options: EpisodeBuildOptions,
): EpisodeCompaction {
  const observations = collectToolObservations(messages, options)
  const evidence = observations.flatMap((observation) =>
    [observation.inputEvidence, observation.resultEvidence].filter((item): item is ToolEvidence =>
      Boolean(item),
    ),
  )
  const goal = extractEpisodeGoal(messages)
  const scope = buildEpisodeScope(observations)
  const confirmedFacts = buildConfirmedFacts(messages, observations)
  const inferredFacts = buildInferredFacts(observations)
  const blockers = buildBlockers(messages, observations)
  const needsRawReview = evidence.map(
    (item) => `${item.toolName}:${item.toolUseId}:${item.kind} -> ${item.path}`,
  )
  const status =
    blockers.length > 0 ? 'blocked' : confirmedFacts.length > 0 ? 'confirmed' : 'inferred'
  const id = `episode_${hashText(
    [
      options.sessionId,
      ...messages.map((message) => message.id),
      ...observations.map((observation) => observation.toolUseId),
    ].join('|'),
  ).slice(0, 16)}`

  return {
    id,
    sessionId: options.sessionId,
    status,
    goal,
    scope,
    toolUseIds: observations.map((observation) => observation.toolUseId),
    confirmedFacts,
    inferredFacts,
    blockers,
    needsRawReview,
    evidence,
    summary: formatEpisodeSummary({
      id,
      status,
      goal,
      scope,
      observations,
      confirmedFacts,
      inferredFacts,
      blockers,
      needsRawReview,
      evidence,
    }),
    messageIds: messages.map((message) => message.id),
  }
}

export function buildWorkingStateCompaction(params: {
  currentGoal: string
  retainedMessages: Message[]
  episodes: EpisodeCompaction[]
}): WorkingStateCompaction {
  const confirmedFacts = uniqueStrings(
    params.episodes.flatMap((episode) => episode.confirmedFacts).slice(-8),
  )
  const blockers = uniqueStrings(params.episodes.flatMap((episode) => episode.blockers).slice(-6))
  const evidencePointers = params.episodes.flatMap((episode) => episode.evidence).slice(-12)
  const recentScope = extractRecentScope(params.retainedMessages)

  return {
    currentGoal: params.currentGoal,
    scope: uniqueStrings([
      ...recentScope,
      ...params.episodes.flatMap((episode) => episode.scope),
    ]).slice(0, 12),
    confirmedFacts,
    nextAction:
      'Continue from the retained high-fidelity recent turn; read evidence paths only when exact raw IO is needed.',
    blockers,
    doNot: [
      'Do not treat inferred facts as confirmed.',
      'Do not replay full tool IO unless a raw evidence path is explicitly needed.',
      'Do not treat a blocked/latest turn as finished without a new user instruction.',
    ],
    evidencePointers,
    sourceEpisodeIds: params.episodes.map((episode) => episode.id),
  }
}

export function formatWorkingState(state: WorkingStateCompaction): string {
  return [
    '<working_state_compaction>',
    `current_goal: ${state.currentGoal}`,
    'scope:',
    ...formatList(state.scope),
    'confirmed_facts:',
    ...formatList(state.confirmedFacts),
    `next_action: ${state.nextAction}`,
    'blockers:',
    ...formatList(state.blockers),
    'do_not:',
    ...formatList(state.doNot),
    'evidence_pointers:',
    ...formatList(
      state.evidencePointers.map(
        (item) => `${item.toolName}:${item.toolUseId}:${item.kind} path=${item.path}`,
      ),
    ),
    `source_episodes: ${state.sourceEpisodeIds.join(', ') || 'none'}`,
    '</working_state_compaction>',
  ].join('\n')
}

export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): { strategy: string; summary: string; scope: string[] } {
  const normalized = toolName.toLowerCase()
  const path = stringValue(input.path) ?? stringValue(input.file_path)

  switch (normalized) {
    case 'read': {
      const range = [stringValue(input.offset), stringValue(input.limit)].filter(Boolean).join(':')
      return {
        strategy: 'read_path_range',
        summary: `read ${path ?? 'unknown path'}${range ? ` range=${range}` : ''}`,
        scope: path ? [path] : [],
      }
    }
    case 'write': {
      const content = stringValue(input.content)
      return {
        strategy: 'write_path_content_size',
        summary: `write ${path ?? 'unknown path'} contentChars=${content?.length ?? 0}`,
        scope: path ? [path] : [],
      }
    }
    case 'edit': {
      const oldText = stringValue(input.old_string) ?? stringValue(input.oldText)
      const newText = stringValue(input.new_string) ?? stringValue(input.newText)
      return {
        strategy: 'edit_path_replacement_size',
        summary: `edit ${path ?? 'unknown path'} oldChars=${oldText?.length ?? 0} newChars=${newText?.length ?? 0}`,
        scope: path ? [path] : [],
      }
    }
    case 'bash': {
      const description = stringValue(input.description)
      const command = stringValue(input.command)
      return {
        strategy: 'bash_description_command_preview',
        summary: `bash ${description ?? command?.replace(/\s+/g, ' ').slice(0, 160) ?? 'command'}`,
        scope: [],
      }
    }
    case 'memory_search': {
      const query = stringValue(input.query)
      return {
        strategy: 'memory_search_query',
        summary: `memory_search query=${query?.slice(0, 180) ?? 'unknown'}`,
        scope: [],
      }
    }
    case 'memory_read': {
      const memoryPath = path ?? stringValue(input.id) ?? stringValue(input.memoryId)
      return {
        strategy: 'memory_read_pointer',
        summary: `memory_read ${memoryPath ?? 'unknown memory'}`,
        scope: memoryPath ? [memoryPath] : [],
      }
    }
    default:
      return {
        strategy: 'generic_tool_input_metadata',
        summary: `${toolName} inputKeys=${Object.keys(input).sort().join(',') || 'none'}`,
        scope: path ? [path] : [],
      }
  }
}

function collectToolObservations(
  messages: Message[],
  options: EpisodeBuildOptions,
): ToolObservation[] {
  const byId = new Map<string, ToolObservation>()

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      const inputEvidence =
        block.evidence ??
        persistToolInputEvidence({
          workDir: options.workDir,
          sessionId: options.sessionId,
          toolUse: block,
        })
      byId.set(block.id, {
        toolUseId: block.id,
        toolName: block.name,
        input: block.input,
        inputEvidence,
      })
    }
  }

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue
      const observation = byId.get(block.toolUseId) ?? {
        toolUseId: block.toolUseId,
        toolName: 'unknown_tool',
      }
      const resultEvidence =
        block.evidence ??
        persistToolResultEvidence({
          workDir: options.workDir,
          sessionId: options.sessionId,
          toolUseId: block.toolUseId,
          toolName: observation.toolName,
          content: block.content,
          outputSummary: block.outputSummary,
        })
      byId.set(block.toolUseId, {
        ...observation,
        result: block,
        resultEvidence,
      })
    }
  }

  return Array.from(byId.values())
}

function formatEpisodeSummary(params: {
  id: string
  status: EpisodeCompaction['status']
  goal: string
  scope: string[]
  observations: ToolObservation[]
  confirmedFacts: string[]
  inferredFacts: string[]
  blockers: string[]
  needsRawReview: string[]
  evidence: ToolEvidence[]
}): string {
  return [
    `<episode_compaction id="${params.id}" status="${params.status}">`,
    `goal: ${params.goal}`,
    'why_tools_were_called:',
    ...formatList(params.observations.map(formatToolReason)),
    'actual_scope_read_or_written:',
    ...formatList(params.scope),
    'learned:',
    ...formatList(params.confirmedFacts),
    'confirmed:',
    ...formatList(params.confirmedFacts),
    'inferred:',
    ...formatList(params.inferredFacts),
    'blocked:',
    ...formatList(params.blockers),
    'must_review_raw_for:',
    ...formatList(params.needsRawReview),
    'full_evidence:',
    ...formatList(
      params.evidence.map(
        (item) =>
          `${item.toolName}:${item.toolUseId}:${item.kind} path=${item.path} chars=${item.chars} sha256=${item.sha256.slice(0, 12)}`,
      ),
    ),
    '</episode_compaction>',
  ].join('\n')
}

function formatToolReason(observation: ToolObservation): string {
  const summary = observation.input
    ? summarizeToolInput(observation.toolName, observation.input).summary
    : `${observation.toolName} input unavailable`
  return `${summary}; result=${formatResultStatus(observation.result)}`
}

function buildEpisodeScope(observations: ToolObservation[]): string[] {
  const scope = observations.flatMap((observation) =>
    observation.input ? summarizeToolInput(observation.toolName, observation.input).scope : [],
  )
  return uniqueStrings(scope).slice(0, 12)
}

function buildConfirmedFacts(messages: Message[], observations: ToolObservation[]): string[] {
  const facts: string[] = []
  for (const observation of observations) {
    const result = observation.result
    if (!result) continue
    if (result.isError) {
      facts.push(`${observation.toolName}:${observation.toolUseId} failed and needs recovery.`)
      continue
    }
    const resultSummary = summarizeToolResult(
      observation.toolName,
      result.content,
      result.outputSummary,
    )
    facts.push(`${observation.toolName}:${observation.toolUseId} ${resultSummary}`)
  }

  const assistantTexts = messages.flatMap((message) =>
    message.role === 'assistant'
      ? message.content.flatMap((block) => (block.type === 'text' ? [block.text.trim()] : []))
      : [],
  )
  for (const text of assistantTexts) {
    if (text.length > 0) facts.push(`assistant concluded: ${truncateOneLine(text, 220)}`)
  }

  return uniqueStrings(facts).slice(0, 12)
}

function buildInferredFacts(observations: ToolObservation[]): string[] {
  const inferred = observations
    .filter((observation) => !observation.result)
    .map(
      (observation) =>
        `${observation.toolName}:${observation.toolUseId} intent is known, but no paired result is present in this compacted episode.`,
    )
  return uniqueStrings(inferred).slice(0, 6)
}

function buildBlockers(messages: Message[], observations: ToolObservation[]): string[] {
  const blockers = observations
    .filter((observation) => observation.result?.isError)
    .map((observation) => {
      const result = observation.result
      return `${observation.toolName}:${observation.toolUseId} error=${truncateOneLine(
        result?.outputSummary ?? result?.content ?? 'unknown error',
        220,
      )}`
    })

  for (const message of messages) {
    if (message.controlKind === 'task_closure') {
      blockers.push(
        'task_closure continuation occurred inside this episode; review raw messages before treating it as fully finished.',
      )
    }
  }

  return uniqueStrings(blockers).slice(0, 8)
}

function summarizeToolResult(toolName: string, content: string, outputSummary?: string): string {
  const normalized = toolName.toLowerCase()
  const source = outputSummary?.trim() || firstUsefulLines(content, normalized === 'bash' ? 4 : 3)

  switch (normalized) {
    case 'write':
      return `confirmed write result: ${truncateOneLine(source || 'write completed', 220)}`
    case 'edit':
      return `confirmed edit result: ${truncateOneLine(source || 'edit completed', 220)}`
    case 'read':
      return `read evidence captured: ${truncateOneLine(source || 'file content captured', 220)}`
    case 'bash':
      return `bash evidence captured: ${truncateOneLine(source || 'command completed', 220)}`
    case 'memory_search':
      return `memory search evidence captured: ${truncateOneLine(source || 'search completed', 220)}`
    case 'memory_read':
      return `memory read evidence captured: ${truncateOneLine(source || 'memory read completed', 220)}`
    default:
      return `tool evidence captured: ${truncateOneLine(source || 'tool completed', 220)}`
  }
}

function extractEpisodeGoal(messages: Message[]): string {
  const userText = messages
    .flatMap((message) =>
      message.role === 'user'
        ? message.content.flatMap((block) => (block.type === 'text' ? [block.text.trim()] : []))
        : [],
    )
    .find((text) => text.length > 0)
  return truncateOneLine(userText ?? 'Earlier tool-backed subproblem', 240)
}

function extractRecentScope(messages: Message[]): string[] {
  const scope: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        scope.push(...summarizeToolInput(block.name, block.input).scope)
      }
    }
  }
  return uniqueStrings(scope).slice(-8)
}

function firstUsefulLines(value: string, maxLines: number): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join(' | ')
}

function formatResultStatus(result?: ToolResultBlock): string {
  if (!result) return 'missing_result'
  return result.isError ? 'error' : 'success'
}

function formatList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['- none']
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function truncateOneLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2)
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortJson(nestedValue)]),
  )
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'unknown'
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
