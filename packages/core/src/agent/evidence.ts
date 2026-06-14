import { createHash } from 'node:crypto'
import type {
  EpisodeCompaction,
  Message,
  ToolEvidence,
  ToolResultBlock,
  WorkingStateCompaction,
} from '@zero-os/shared'
import { CONTEXT_PARAMS } from './params'
import {
  persistToolInputEvidence,
  persistToolResultEvidence,
  summarizeToolInput,
  summarizeToolResult,
  truncateOneLine,
} from './tool-evidence'

export interface EpisodeBuildOptions {
  workDir: string
  sessionId: string
}

interface ToolObservation {
  toolUseId: string
  toolName: string
  input?: Record<string, unknown>
  inputEvidence?: ToolEvidence
  result?: ToolResultBlock
  resultEvidence?: ToolEvidence
}

export const episodeBoundaryStrategy = 'deterministic_contiguous_older_turns_v1'
export const episodeBoundaryReason =
  'Grouped from contiguous older replay messages after the latest active turn; future semantic classifiers can replace this boundary without changing evidence pointers.'

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
  const confirmedFacts = buildConfirmedFacts(observations)
  const inferredFacts = buildInferredFacts(messages, observations)
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
    boundaryStrategy: episodeBoundaryStrategy,
    boundaryReason: episodeBoundaryReason,
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
  const blockers = uniqueStrings(params.episodes.flatMap((episode) => episode.blockers).slice(-6))
  const recentScope = extractRecentScope(params.retainedMessages)

  return {
    currentGoal: params.currentGoal,
    scope: uniqueStrings([
      ...recentScope,
      ...params.episodes.flatMap((episode) => episode.scope),
    ]).slice(0, 12),
    confirmedFacts: [],
    nextAction:
      'Continue from the retained high-fidelity recent turn; read evidence paths only when exact raw IO is needed.',
    blockers,
    doNot: [
      'Do not treat inferred facts as confirmed.',
      'Do not replay full tool IO unless a raw evidence path is explicitly needed.',
      'Do not treat a blocked/latest turn as finished without a new user instruction.',
    ],
    evidencePointers: [],
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

function buildEpisodeScope(observations: ToolObservation[]): string[] {
  const scope = observations.flatMap((observation) =>
    observation.input ? summarizeToolInput(observation.toolName, observation.input).scope : [],
  )
  return uniqueStrings(scope).slice(0, 12)
}

function buildConfirmedFacts(observations: ToolObservation[]): string[] {
  const facts: string[] = []
  for (const observation of observations) {
    const result = observation.result
    if (!result) continue
    if (result.isError) continue

    const evidenceSuffix = observation.resultEvidence
      ? ` evidence=${observation.resultEvidence.path} chars=${observation.resultEvidence.chars} sha256=${observation.resultEvidence.sha256.slice(0, 12)}`
      : ` chars=${result.content.length}`
    facts.push(
      `${observation.toolName}:${observation.toolUseId} returned a tool_result payload; this confirms only the tool IO was captured, not any model interpretation.${evidenceSuffix}`,
    )
  }

  return uniqueStrings(facts).slice(0, 12)
}

function buildInferredFacts(messages: Message[], observations: ToolObservation[]): string[] {
  const inferred: string[] = observations
    .filter((observation) => !observation.result)
    .map(
      (observation) =>
        `${observation.toolName}:${observation.toolUseId} intent is known, but no paired result is present in this compacted episode.`,
    )

  const assistantTexts = messages.flatMap((message) =>
    message.role === 'assistant'
      ? message.content.flatMap((block) => (block.type === 'text' ? [block.text.trim()] : []))
      : [],
  )
  for (const text of assistantTexts) {
    if (text.length > 0) {
      inferred.push(`assistant text, not independently confirmed: ${truncateOneLine(text, 220)}`)
    }
  }

  for (const observation of observations) {
    const result = observation.result
    if (!result || result.isError) continue
    const resultSummary = summarizeToolResult(
      observation.toolName,
      result.content,
      result.outputSummary,
    )
    inferred.push(
      `${observation.toolName}:${observation.toolUseId} output summary for orientation only: ${resultSummary}`,
    )
  }

  return uniqueStrings(inferred).slice(0, 8)
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
    if (message.taskClosure?.action === 'block') {
      blockers.push(
        `task_closure=block for this episode; recovery is required before treating it as finished. reason=${truncateOneLine(message.taskClosure.reason, 220)}`,
      )
      continue
    }

    if (message.controlKind === 'task_closure') {
      const reason = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text.trim()] : []))
        .find((text) => text.length > 0)
      blockers.push(
        `task_closure continuation occurred inside this episode; review raw messages before treating it as fully finished.${reason ? ` reason=${truncateOneLine(reason, 220)}` : ''}`,
      )
    }
  }

  return uniqueStrings(blockers).slice(0, 8)
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

function formatEpisodeSummary(params: {
  id: string
  status: EpisodeCompaction['status']
  boundaryStrategy?: string
  boundaryReason?: string
  goal: string
  scope: string[]
  observations: ToolObservation[]
  confirmedFacts: string[]
  inferredFacts: string[]
  blockers: string[]
  needsRawReview: string[]
  evidence: ToolEvidence[]
}): string {
  const observationLimit = CONTEXT_PARAMS.history.episodePromptObservationLimit
  const evidenceLimit = CONTEXT_PARAMS.history.episodePromptEvidenceLimit
  const observations = params.observations.slice(0, observationLimit).map(formatToolReason)
  const omittedObservations = params.observations.length - observations.length
  if (omittedObservations > 0)
    observations.push(`omitted_tool_observation_count=${omittedObservations}`)
  const evidence = params.evidence
    .slice(0, evidenceLimit)
    .map(
      (item) =>
        `${item.toolName}:${item.toolUseId}:${item.kind} path=${item.path} chars=${item.chars} sha256=${item.sha256.slice(0, 12)}`,
    )
  const omittedEvidence = params.evidence.length - evidence.length
  if (omittedEvidence > 0) evidence.push(`omitted_evidence_count=${omittedEvidence}`)

  return [
    `<episode_evidence_index id="${params.id}" status="${params.status}">`,
    `boundary_strategy: ${params.boundaryStrategy ?? episodeBoundaryStrategy}`,
    `boundary_reason: ${params.boundaryReason ?? episodeBoundaryReason}`,
    `goal: ${params.goal}`,
    'scope:',
    ...formatList(params.scope.slice(0, 12)),
    'tool_observations:',
    ...formatList(observations),
    'blocked:',
    ...formatList(params.blockers),
    'evidence_manifest:',
    ...formatList(evidence),
    '</episode_evidence_index>',
  ].join('\n')
}

function formatToolReason(observation: ToolObservation): string {
  const summary = observation.input
    ? summarizeToolInput(observation.toolName, observation.input).summary
    : `${observation.toolName} input unavailable`
  return `${summary}; result=${formatResultStatus(observation.result)}`
}

function formatResultStatus(result?: ToolResultBlock): string {
  if (!result) return 'missing_result'
  return result.isError ? 'error' : 'success'
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

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
