import type { RunLogEntry, SessionRow, TraceEntry } from '@zero-os/observe'
import {
  type Message,
  type SecretFilter,
  type SourceCard,
  type SourceCardValidationResult,
  now,
  validateSourceCard,
} from '@zero-os/shared'

const MAX_EVIDENCE_TEXT_CHARS = 4_000
const MAX_EVIDENCE_REFS = 12

const SENSITIVE_KEY_RE =
  /(authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|oauth|auth[_-]?code|credentialRef|credentialLeaseId)/i
const SENSITIVE_VALUE_RE =
  /(Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+)|(vault:\/\/[^\s"',}]+)|(external:[^\s"',}]+)/i
const URL_RE = /https?:\/\/[^\s"'<>)}\]]+/gi
const ARTIFACT_PATH_RE = /(?:路径:\s*)?((?:\/[^\s"'<>]+)?\.artifacts\/[^\s"'<>]+)/gi
const PRIVATE_CONTENT_KEY_RE =
  /(body|bodyText|bodyHtml|mailBody|messageBody|emailBody|attachment|attachmentText|attachmentContent|raw|rawPayload|payload|mime|html|contentBody|fileBytes)/i

export type SourceCardDraftEvidenceSource = 'trace' | 'run_log' | 'message' | 'artifact'
export type SourceCardDraftDedupeDecision = 'new_card' | 'append_evidence'

export interface SourceCardDraftEvidenceRef {
  source: SourceCardDraftEvidenceSource
  ref: string
  summary: string
  observedAt?: string
}

export interface SourceCardDraftDedupeCandidate {
  id: string
  title: string
  state: SourceCard['state']
  sensitivity: SourceCard['sensitivity']
  score: number
  reason: string
}

export interface SourceCardDraftTriggerSnapshot {
  sessionId: string
  capturedAt: string
  traceEntryCount: number
  runLogEntryCount: number
  messageCount: number
  artifactRefCount: number
}

export interface SourceCardDraft {
  schemaVersion: 1
  proposedCard: SourceCard
  evidenceRefs: SourceCardDraftEvidenceRef[]
  missingFields: string[]
  riskFlags: string[]
  dedupeCandidates: SourceCardDraftDedupeCandidate[]
  confidence: number
  sourceSessionId: string
  generatedAt: string
  triggerSnapshot: SourceCardDraftTriggerSnapshot
}

export interface SourceCardDraftCreateRequest {
  draft: SourceCardDraft
  confirm: boolean
  dedupeDecision?: SourceCardDraftDedupeDecision
}

export interface SourceCardDraftValidationResult extends SourceCardValidationResult {
  sourceCardValidation: SourceCardValidationResult
}

export interface SessionSourceMinerArtifact {
  ref: string
  path?: string
  text?: string
  sizeBytes?: number
}

export interface SessionSourceMinerOptions {
  currentSession?: boolean
  artifactSearchRoots?: string[]
}

export interface SessionSourceMinerReader {
  readSession(sessionId: string): SessionRow | SessionMinerSession | null | undefined
  readMessages(sessionId: string): Message[]
  readTraceEntries(sessionId: string): TraceEntry[]
  readRunLog(sessionId: string): RunLogEntry[]
  readArtifacts?(
    sessionId: string,
    options: { artifactRefs: string[]; artifactSearchRoots?: string[] },
  ): SessionSourceMinerArtifact[]
}

export interface SessionMinerSession {
  id: string
  source?: string
  summary?: string
  createdAt?: string
  updatedAt?: string
}

export interface SourceCardDedupeSource {
  id: string
  title: string
  state: SourceCard['state']
  sensitivity: SourceCard['sensitivity']
  tags?: string[]
}

export interface SessionSourceMinerDeps {
  reader: SessionSourceMinerReader
  listSourceCards?: () => SourceCardDedupeSource[]
  secretFilter?: SecretFilter
}

interface CollectedEvidence {
  source: SourceCardDraftEvidenceSource
  ref: string
  text: string
  observedAt?: string
}

interface SourceAnalysis {
  title: string
  sensitivity: SourceCard['sensitivity']
  tags: string[]
  sourceDocBody: string
  missingFields: string[]
  riskFlags: string[]
  confidence: number
}

export class SessionSourceMiner {
  constructor(private readonly deps: SessionSourceMinerDeps) {}

  generateDraft(sessionId: string, options: SessionSourceMinerOptions = {}): SourceCardDraft {
    const session = this.deps.reader.readSession(sessionId)
    const messages = this.deps.reader.readMessages(sessionId)
    const traceEntries = this.deps.reader.readTraceEntries(sessionId)
    const runLogEntries = this.deps.reader.readRunLog(sessionId)

    let evidence = collectSessionEvidence({
      messages,
      traceEntries,
      runLogEntries,
      secretFilter: this.deps.secretFilter,
    })
    const artifactRefs = extractArtifactRefs(evidence.map((item) => item.text).join('\n'))
    const artifacts =
      this.deps.reader.readArtifacts?.(sessionId, {
        artifactRefs,
        artifactSearchRoots: options.artifactSearchRoots,
      }) ?? []
    evidence = [
      ...evidence,
      ...artifacts.map((artifact, index) =>
        artifactToEvidence(artifact, index, this.deps.secretFilter),
      ),
    ]

    if (!session && evidence.length === 0) {
      throw new Error(`Session "${sessionId}" was not found or has no persisted evidence`)
    }

    const generatedAt = now()
    const analysis = analyzeEvidence(evidence)
    const proposedCard = buildProposedCard(sessionId, analysis)
    const evidenceRefs = buildEvidenceRefs(evidence, proposedCard.sensitivity)
    const dedupeCandidates = findSourceCardDraftDedupeCandidates(
      proposedCard,
      this.deps.listSourceCards?.() ?? [],
    )
    const riskFlags = [...analysis.riskFlags]
    if (dedupeCandidates.length > 0) {
      riskFlags.push('Possible existing Source Card match; user must choose new card or skip.')
    }
    if (options.currentSession) {
      riskFlags.push('Draft is based on the current session snapshot captured at trigger time.')
    }

    return redactSourceCardDraft(
      {
        schemaVersion: 1,
        proposedCard,
        evidenceRefs,
        missingFields: analysis.missingFields,
        riskFlags,
        dedupeCandidates,
        confidence: analysis.confidence,
        sourceSessionId: sessionId,
        generatedAt,
        triggerSnapshot: {
          sessionId,
          capturedAt: generatedAt,
          traceEntryCount: traceEntries.length,
          runLogEntryCount: runLogEntries.length,
          messageCount: messages.length,
          artifactRefCount: artifactRefs.length + artifacts.length,
        },
      },
      this.deps.secretFilter,
    )
  }
}

export function validateSourceCardDraft(draft: unknown): SourceCardDraftValidationResult {
  const errors: string[] = []
  const record = asRecord(draft)
  if (!record) {
    return {
      ok: false,
      errors: ['SourceCardDraft must be an object'],
      sourceCardValidation: { ok: false, errors: ['proposedCard is missing'] },
    }
  }

  if (record.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (typeof record.sourceSessionId !== 'string' || record.sourceSessionId.trim().length === 0) {
    errors.push('sourceSessionId is required')
  }
  if (typeof record.generatedAt !== 'string' || record.generatedAt.trim().length === 0) {
    errors.push('generatedAt is required')
  }
  if (!Array.isArray(record.evidenceRefs)) errors.push('evidenceRefs must be an array')
  if (!Array.isArray(record.missingFields)) errors.push('missingFields must be an array')
  if (!Array.isArray(record.riskFlags)) errors.push('riskFlags must be an array')
  if (!Array.isArray(record.dedupeCandidates)) errors.push('dedupeCandidates must be an array')
  if (typeof record.confidence !== 'number' || record.confidence < 0 || record.confidence > 1) {
    errors.push('confidence must be a number between 0 and 1')
  }

  const sourceCardValidation = validateSourceCard(record.proposedCard)
  if (!sourceCardValidation.ok) {
    errors.push(...sourceCardValidation.errors.map((error) => `proposedCard.${error}`))
  }

  const proposedCard = asRecord(record.proposedCard)
  if (proposedCard?.state === 'active') {
    errors.push('proposedCard.state must not be active in a draft')
  }
  if (containsSensitiveDraftMaterial(record)) {
    errors.push('SourceCardDraft contains unredacted credential or secret material')
  }

  return {
    ok: errors.length === 0,
    errors,
    sourceCardValidation,
  }
}

export function redactSourceCardDraft<T>(value: T, secretFilter?: SecretFilter): T {
  return redactStrict(value, secretFilter) as T
}

export function containsSensitiveDraftMaterial(value: unknown): boolean {
  const text = JSON.stringify(value)
  if (SENSITIVE_VALUE_RE.test(text)) return true
  if (/"(credentialRef|credentialLeaseId)"\s*:/i.test(text)) return true
  return /"(authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)"\s*:\s*"(?!\[REDACTED\])[^"]+"/i.test(
    text,
  )
}

export function findSourceCardDraftDedupeCandidates(
  proposedCard: SourceCard,
  existingCards: SourceCardDedupeSource[],
): SourceCardDraftDedupeCandidate[] {
  return existingCards
    .map((card) => {
      const score = scoreDedupe(proposedCard, card)
      return {
        id: card.id,
        title: card.title,
        state: card.state,
        sensitivity: card.sensitivity,
        score,
        reason: buildDedupeReason(proposedCard, card, score),
      }
    })
    .filter((candidate) => candidate.score >= 0.45)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
}

function collectSessionEvidence(input: {
  messages: Message[]
  traceEntries: TraceEntry[]
  runLogEntries: RunLogEntry[]
  secretFilter?: SecretFilter
}): CollectedEvidence[] {
  const evidence: CollectedEvidence[] = []

  input.messages.forEach((message, index) => {
    const text = summarizeMessage(message)
    if (!text) return
    evidence.push({
      source: 'message',
      ref: `message:${index}:${message.id}`,
      text: truncateEvidenceText(redactStrictText(text, input.secretFilter)),
      observedAt: message.createdAt,
    })
  })

  input.traceEntries.forEach((entry, index) => {
    evidence.push({
      source: 'trace',
      ref: `trace:${entry.spanId || index}`,
      text: truncateEvidenceText(
        redactStrictText(
          `${entry.kind} ${entry.name} ${JSON.stringify({
            data: entry.data,
            metadata: entry.metadata,
          })}`,
          input.secretFilter,
        ),
      ),
      observedAt: entry.endTime ?? entry.startTime,
    })
  })

  input.runLogEntries.forEach((entry, index) => {
    evidence.push({
      source: 'run_log',
      ref: `run_log:${index}`,
      text: truncateEvidenceText(
        redactStrictText(
          `${entry.level} ${entry.event} ${entry.name ?? ''} ${JSON.stringify({
            data: entry.data,
            metadata: entry.metadata,
          })}`,
          input.secretFilter,
        ),
      ),
      observedAt: entry.ts,
    })
  })

  return evidence
}

function summarizeMessage(message: Message): string {
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_use') {
        return `tool_use ${block.name} ${JSON.stringify(block.input)}`
      }
      if (block.type === 'tool_result') {
        return `tool_result ${block.outputSummary ?? ''} ${block.content}`
      }
      if (block.type === 'image') return 'image attachment'
      if (block.type === 'thinking') return ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function artifactToEvidence(
  artifact: SessionSourceMinerArtifact,
  index: number,
  secretFilter?: SecretFilter,
): CollectedEvidence {
  const text = artifact.text
    ? `artifact ${artifact.ref} ${artifact.text}`
    : `artifact ${artifact.ref} ${artifact.path ?? ''} ${artifact.sizeBytes ?? ''}`
  return {
    source: 'artifact',
    ref: `artifact:${index}:${artifact.ref}`,
    text: truncateEvidenceText(redactStrictText(text, secretFilter)),
  }
}

function analyzeEvidence(evidence: CollectedEvidence[]): SourceAnalysis {
  const combined = evidence.map((item) => item.text).join('\n')
  const lower = combined.toLowerCase()
  const tags = inferTags(lower)
  const sensitivity = inferSensitivity(tags, lower)
  const urls = extractUrls(combined)
  const title = buildTitle(tags, lower)
  const riskFlags = [
    'Draft only: no Source Card has been activated.',
    'Session Source Miner only used existing session evidence.',
    'Did not execute CLI/API/browser/fetch or read a new data source.',
  ]
  if (sensitivity === 'private' || sensitivity === 'restricted') {
    riskFlags.push('Private/restricted source must stay explicit foreground and metadata-first.')
  }
  const missingFields = urls.length === 0 && !lower.includes('himalaya') ? ['document.method'] : []

  return {
    title,
    sensitivity,
    tags,
    sourceDocBody: buildSourceDocBody({ title, sensitivity, tags, urls, evidence }),
    missingFields,
    riskFlags,
    confidence: estimateConfidence(evidence, urls, tags),
  }
}

function buildProposedCard(sessionId: string, analysis: SourceAnalysis): SourceCard {
  return {
    schemaVersion: 1,
    id: buildSourceCardId(analysis.title, sessionId),
    title: analysis.title,
    state: 'draft',
    sensitivity: analysis.sensitivity,
    tags: analysis.tags,
    sourceDoc: {
      format: 'markdown',
      body: analysis.sourceDocBody,
    },
    source: {
      sessionId,
      summary: `Draft mined from ${analysis.tags.join(', ') || 'session'} evidence.`,
    },
  }
}

function buildSourceDocBody(input: {
  title: string
  sensitivity: SourceCard['sensitivity']
  tags: string[]
  urls: string[]
  evidence: CollectedEvidence[]
}): string {
  const methodLines = buildMethodLines(input)
  return [
    `# ${input.title}`,
    '',
    '## When to use',
    `- Use when a future request matches: ${input.tags.join(', ') || 'this source'}.`,
    '',
    '## How to use',
    ...methodLines,
    '',
    '## Safety boundary',
    `- Sensitivity: ${input.sensitivity}.`,
    input.sensitivity === 'public'
      ? '- Use public read-only access only. Do not perform account, trading, sending, or write actions unless this document explicitly says so.'
      : '- Treat as private/restricted. Prefer metadata. Do not read body content, attachments, or secrets without explicit foreground user approval.',
    '',
    '## Evidence',
    ...input.evidence
      .slice(0, 3)
      .map((item) => `- ${item.ref}: ${summarizeEvidenceText(item.text)}`),
  ].join('\n')
}

function buildMethodLines(input: {
  tags: string[]
  urls: string[]
  evidence: CollectedEvidence[]
}): string[] {
  if (input.tags.includes('mail') && hasEvidence(input.evidence, 'himalaya')) {
    return [
      '- Use himalaya CLI metadata commands first.',
      '- Start with account/folder discovery, then bounded envelope metadata reads.',
    ]
  }
  if (input.urls.length > 0) {
    return input.urls.slice(0, 6).map((url) => `- ${url}`)
  }
  return ['- Method needs human review; the miner did not find a stable command or URL.']
}

function buildEvidenceRefs(
  evidence: CollectedEvidence[],
  sensitivity: SourceCard['sensitivity'],
): SourceCardDraftEvidenceRef[] {
  const metadataOnly = sensitivity === 'private' || sensitivity === 'restricted'
  return [...evidence]
    .sort((left, right) => evidenceScore(right.text) - evidenceScore(left.text))
    .slice(0, MAX_EVIDENCE_REFS)
    .map((item) => ({
      source: item.source,
      ref: item.ref,
      summary: metadataOnly
        ? summarizePrivateEvidenceMetadata(item)
        : summarizeEvidenceText(item.text),
      observedAt: item.observedAt,
    }))
}

function inferTags(text: string): string[] {
  const tags = new Set<string>()
  if (/(himalaya|imap|smtp|mailbox|email|e-mail|gmail|qq\s*mail|envelope)/i.test(text)) {
    tags.add('mail')
    if (/qq/i.test(text)) tags.add('qq-mail')
    if (/himalaya/i.test(text)) tags.add('himalaya')
  }
  if (/(stock|market|quote|eastmoney|akshare|tushare|ticker|symbol|证券|股票|行情)/i.test(text)) {
    tags.add('market-data')
    tags.add('a-share')
  }
  if (/(browser|playwright|page\.|click|screenshot)/i.test(text)) tags.add('browser')
  if (/(local_file|read tool|write tool|\.csv|\.json|\.xlsx|\.artifacts)/i.test(text)) {
    tags.add('local-file')
  }
  return [...tags]
}

function inferSensitivity(tags: string[], text: string): SourceCard['sensitivity'] {
  if (tags.includes('mail')) return 'private'
  if (
    /(authorization|cookie|password|token|secret|oauth|credential|api[_-]?key|vault:\/\/|external:)/i.test(
      text,
    )
  ) {
    return 'restricted'
  }
  if (tags.includes('market-data')) return 'public'
  return 'internal'
}

function buildTitle(tags: string[], text: string): string {
  if (tags.includes('qq-mail')) return 'QQ Mail source'
  if (tags.includes('mail')) return 'Mail source'
  if (tags.includes('a-share')) return 'A-share market data'
  if (tags.includes('browser')) return 'Browser session source'
  if (tags.includes('local-file')) return 'Local file source'
  const url = extractUrls(text)[0]
  if (url) {
    try {
      return `${new URL(url).hostname} source`
    } catch {
      return 'Web source'
    }
  }
  return 'Session source'
}

function buildSourceCardId(title: string, sessionId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const suffix = sessionId
    .replace(/^sess_/, '')
    .replace(/[^a-z0-9]+/gi, '')
    .slice(-8)
    .toLowerCase()
  return `${slug || 'source'}-${suffix || 'draft'}`
}

function extractUrls(text: string): string[] {
  return Array.from(new Set(text.match(URL_RE) ?? [])).slice(0, 12)
}

function hasEvidence(evidence: CollectedEvidence[], pattern: string): boolean {
  return evidence.some((item) => item.text.toLowerCase().includes(pattern.toLowerCase()))
}

function estimateConfidence(evidence: CollectedEvidence[], urls: string[], tags: string[]): number {
  let score = 0.35
  if (evidence.length > 0) score += 0.2
  if (urls.length > 0) score += 0.2
  if (tags.length > 0) score += 0.15
  if (evidence.some((item) => /status(code)?\s*200|exit(code)?\s*0|success/i.test(item.text))) {
    score += 0.1
  }
  return Math.min(0.95, Number(score.toFixed(2)))
}

function scoreDedupe(proposedCard: SourceCard, existingCard: SourceCardDedupeSource): number {
  let score = 0
  if (proposedCard.id === existingCard.id) score += 0.6
  if (normalizeText(proposedCard.title) === normalizeText(existingCard.title)) score += 0.35
  const proposedTags = new Set(proposedCard.tags ?? [])
  const existingTags = existingCard.tags ?? []
  const overlap = existingTags.filter((tag) => proposedTags.has(tag)).length
  if (overlap > 0) score += Math.min(0.4, overlap * 0.15)
  if (proposedCard.sensitivity === existingCard.sensitivity) score += 0.1
  return Math.min(1, Number(score.toFixed(2)))
}

function buildDedupeReason(
  proposedCard: SourceCard,
  existingCard: SourceCardDedupeSource,
  score: number,
): string {
  if (proposedCard.id === existingCard.id) return 'same id'
  if (normalizeText(proposedCard.title) === normalizeText(existingCard.title)) {
    return `similar title; score ${score}`
  }
  const overlap = (existingCard.tags ?? []).filter((tag) => proposedCard.tags?.includes(tag))
  return overlap.length > 0 ? `tag overlap: ${overlap.join(', ')}` : `score ${score}`
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
}

function extractArtifactRefs(text: string): string[] {
  const refs = new Set<string>()
  for (const match of text.matchAll(ARTIFACT_PATH_RE)) {
    if (match[1]) refs.add(match[1])
  }
  return [...refs].slice(0, MAX_EVIDENCE_REFS)
}

function evidenceScore(text: string): number {
  let score = 0
  if (/https?:\/\//i.test(text)) score += 2
  if (/(status(code)?\s*200|exit(code)?\s*0|success)/i.test(text)) score += 2
  if (/(schema|field|json|csv|parser|himalaya|folder|envelope)/i.test(text)) score += 1
  if (PRIVATE_CONTENT_KEY_RE.test(text)) score -= 2
  return score
}

function summarizeEvidenceText(text: string): string {
  return truncateEvidenceText(text.replace(/\s+/g, ' '), 600)
}

function summarizePrivateEvidenceMetadata(item: CollectedEvidence): string {
  const hints = new Set<string>(['metadata-only summary'])
  if (/himalaya/i.test(item.text)) hints.add('cli:himalaya')
  if (/folder/i.test(item.text)) hints.add('folder signal')
  if (/envelope/i.test(item.text)) hints.add('envelope metadata signal')
  if (/https?:\/\//i.test(item.text)) hints.add('url signal')
  if (/status(code)?/i.test(item.text)) hints.add('status signal')
  if (PRIVATE_CONTENT_KEY_RE.test(item.text)) hints.add('private payload redacted')
  return [...hints].join('; ')
}

function truncateEvidenceText(text: string, max = MAX_EVIDENCE_TEXT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}... [truncated]` : text
}

function redactStrict<T>(value: T, secretFilter?: SecretFilter): unknown {
  if (typeof value === 'string') return redactStrictText(value, secretFilter)
  if (Array.isArray(value)) return value.map((item) => redactStrict(item, secretFilter))
  const record = asRecord(value)
  if (!record) return value
  return Object.fromEntries(
    Object.entries(record).map(([key, nested]) =>
      SENSITIVE_KEY_RE.test(key)
        ? ['redacted_key', '[REDACTED]']
        : [key, redactStrict(nested, secretFilter)],
    ),
  )
}

function redactStrictText(text: string, secretFilter?: SecretFilter): string {
  const filtered = secretFilter?.filter(text) ?? text
  return filtered
    .replace(
      /("?)(credentialRef|credentialLeaseId)\1\s*:\s*("[^"]*"|[^\s,}]+)/gi,
      '"redacted_key":"[REDACTED]"',
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:vault:\/\/|external:)[^\s"',}]+/gi, '[REDACTED_REFERENCE]')
    .replace(
      /(authorization|cookie|password|token|secret|api[_-]?key):\s*([^\n]+)/gi,
      'redacted_key: [REDACTED]',
    )
    .replace(
      /(authorization|cookie|password|token|secret|api[_-]?key)=([^&\s]+)/gi,
      'redacted_key=[REDACTED]',
    )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
