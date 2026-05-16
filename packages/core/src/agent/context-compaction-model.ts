import type { Message, ToolEvidence } from '@zero-os/shared'
import type { ContextCompactionModelInput, ContextCompactionModelOutput } from './context'
import { CONTEXT_PARAMS } from './params'

export const CONTEXT_COMPACTION_SYSTEM_PROMPT = [
  'You are the ZeRo OS Context Compact Model.',
  'Compress a closed group of conversation messages into durable semantic working context.',
  'Do not concatenate raw tool IO. Preserve conclusions, constraints, decisions, blockers, and evidence pointers.',
  'Distinguish confirmed facts from model inference. Keep raw IO references as evidence paths only.',
  'Return only JSON matching the requested schema.',
].join('\n')

export function buildContextCompactionPrompt(input: ContextCompactionModelInput): string {
  const evidenceManifest = formatModelEvidenceManifest(input.episode.evidence)
  const transcript = boundedJoin(input.segment.map(renderMessageForCompaction), '\n\n', 28000)

  return `<instruction>
Analyze and compact the covered messages into semantic context for a future agent turn.

The compact result will replace these raw messages in the model prompt, while the raw messages and full tool IO remain available through the evidence paths.

Write for a future agent that must continue the session accurately.

Rules:
- Do not paste raw tool output or large tool inputs.
- Do not say a fact is confirmed unless it is supported by a user message or a tool result.
- Preserve user corrections, constraints, and decisions.
- Preserve unresolved blockers separately from completed work.
- Prefer concrete names, paths, dates, amounts, and IDs when they matter.
- Use evidence path references only when exact raw IO may need review.
- Keep each array short and high-signal.

Return JSON only:
{
  "summary": "compact semantic summary",
  "confirmedFacts": ["..."],
  "userConstraints": ["..."],
  "decisions": ["..."],
  "currentState": ["..."],
  "openQuestions": ["..."],
  "nextActions": ["..."],
  "doNotInfer": ["..."],
  "keyEvidence": ["toolName:toolUseId path=... reason=..."]
}
</instruction>

<metadata>
session_id: ${input.sessionId}
block_id: ${input.blockId}
strategy_version: ${input.strategyVersion}
current_goal: ${input.currentGoal}
covered_message_count: ${input.segment.length}
tool_use_ids: ${input.episode.toolUseIds.join(', ') || 'none'}
episode_status: ${input.episode.status}
</metadata>

<evidence_manifest>
${evidenceManifest || '- none'}
</evidence_manifest>

<covered_messages>
${transcript}
</covered_messages>`
}

function formatModelEvidenceManifest(evidence: ToolEvidence[]): string {
  const limit = CONTEXT_PARAMS.history.episodePromptEvidenceLimit
  const lines = evidence
    .slice(0, limit)
    .map(
      (item) =>
        `- ${item.toolName}:${item.toolUseId}:${item.kind} path=${item.path} chars=${item.chars} sha256=${item.sha256.slice(0, 12)} summary=${compactLine(item.summary ?? 'captured', 180)}`,
    )
  const omitted = evidence.length - lines.length
  if (omitted > 0) {
    lines.push(`- omitted_evidence count=${omitted} reason=evidence_manifest_limit_${limit}`)
  }
  return lines.join('\n')
}

export function parseContextCompactionModelOutput(
  value: string,
): ContextCompactionModelOutput | undefined {
  const jsonText = extractJsonObject(value)
  if (!jsonText) return undefined

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    const summary = asString(parsed.summary)
    if (!summary) return undefined

    return {
      summary,
      confirmedFacts: asStringArray(parsed.confirmedFacts),
      userConstraints: asStringArray(parsed.userConstraints),
      decisions: asStringArray(parsed.decisions),
      currentState: asStringArray(parsed.currentState),
      openQuestions: asStringArray(parsed.openQuestions),
      nextActions: asStringArray(parsed.nextActions),
      doNotInfer: asStringArray(parsed.doNotInfer),
      keyEvidence: asStringArray(parsed.keyEvidence),
    }
  } catch {
    return undefined
  }
}

function renderMessageForCompaction(message: Message, index: number): string {
  const parts = message.content.map((block) => {
    if (block.type === 'text') return compactLine(block.text, 1200)
    if (block.type === 'tool_use') {
      return `[tool_use:${block.name}:${block.id}] input=${compactLine(JSON.stringify(block.input), 1000)}`
    }
    if (block.type === 'tool_result') {
      const content = block.outputSummary?.trim() || firstUsefulLines(block.content, 5)
      return `[tool_result:${block.toolUseId}:${block.isError ? 'error' : 'success'}] ${compactLine(content, 1200)}`
    }
    if (block.type === 'thinking') return '[thinking omitted]'
    return `[${block.type}]`
  })

  return [
    `<message index="${index}" id="${message.id}" role="${message.role}" type="${message.messageType}">`,
    parts.join('\n'),
    '</message>',
  ].join('\n')
}

function boundedJoin(items: string[], separator: string, maxChars: number): string {
  const included: string[] = []
  let total = 0
  for (const item of items) {
    const nextTotal = total + item.length + (included.length > 0 ? separator.length : 0)
    if (nextTotal > maxChars) break
    included.push(item)
    total = nextTotal
  }
  const omitted = items.length - included.length
  if (omitted > 0) included.push(`<omitted_messages count="${omitted}" />`)
  return included.join(separator)
}

function extractJsonObject(value: string): string | undefined {
  const withoutFence = value.replace(/```(?:json)?/g, '').trim()
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  return withoutFence.slice(start, end + 1)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value
    .map((item) => (typeof item === 'string' ? item.trim() : undefined))
    .filter((item): item is string => Boolean(item))
  return strings.length > 0 ? strings : undefined
}

function firstUsefulLines(value: string, maxLines: number): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join(' | ')
}

function compactLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized
}
