import type { RunLogEntry, SessionRow, TraceEntry } from '@zero-os/observe'
import {
  type Message,
  type SecretFilter,
  type SourceCard,
  type SourceCardAdapterMode,
  type SourceCardCapability,
  type SourceCardValidationResult,
  now,
  validateSourceCard,
} from '@zero-os/shared'

const MAX_EVIDENCE_TEXT_CHARS = 4_000
const MAX_EVIDENCE_REFS = 12
const MAX_SCHEMA_KEYS = 12

const SENSITIVE_KEY_RE =
  /(authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|oauth|auth[_-]?code|credentialRef|credentialLeaseId)/i
const SENSITIVE_VALUE_RE =
  /(Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+)|(vault:\/\/[^\s"',}]+)|(external:[^\s"',}]+)/i
const URL_RE = /https?:\/\/[^\s"'<>)}\]]+/gi
const ARTIFACT_PATH_RE = /(?:路径:\s*)?((?:\/[^\s"'<>]+)?\.artifacts\/[^\s"'<>]+)/gi
const PRIVATE_CONTENT_KEY_RE =
  /(body|bodyText|bodyHtml|mailBody|messageBody|emailBody|attachment|attachmentText|attachmentContent|raw|rawPayload|payload|mime|html|contentBody|fileBytes)/i

export type SourceCardDraftEvidenceSource = 'trace' | 'run_log' | 'message' | 'artifact'
export type SourceCardDraftDedupeDecision =
  | 'new_card'
  | 'append_adapter_revision'
  | 'append_evidence'

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
  kind: SourceCard['kind']
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

export interface SourceCardDraftCandidateRequest {
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
  kind: SourceCard['kind']
  sensitivity: SourceCard['sensitivity']
  capabilities?: Array<{ id: string }>
  adapter?: { mode?: SourceCardAdapterMode }
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
  kind: SourceCard['kind']
  title: string
  sensitivity: SourceCard['sensitivity']
  mode: SourceCardAdapterMode
  entrypoint: string
  parserType: SourceCard['adapter']['revisions'][number]['parser']['type']
  schemaKeys: string[]
  capabilities: SourceCardCapability[]
  requiresCredential: boolean
  privacy: SourceCard['privacy']
  missingFields: string[]
  riskFlags: string[]
  confidence: number
  learnedMethodSummary: string
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
    const analysis = analyzeEvidence(evidence, session)
    const proposedCard = buildProposedCard(sessionId, generatedAt, analysis, evidence)
    const evidenceRefs = buildEvidenceRefs(evidence, proposedCard.sensitivity)
    const dedupeCandidates = findSourceCardDraftDedupeCandidates(
      proposedCard,
      this.deps.listSourceCards?.() ?? [],
    )
    const riskFlags = [...analysis.riskFlags]
    if (dedupeCandidates.length > 0) {
      riskFlags.push(
        'Possible existing Source Card match; user must choose new card vs adapter revision/evidence append.',
      )
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

function analyzeEvidence(
  evidence: CollectedEvidence[],
  session: SessionRow | SessionMinerSession | null | undefined,
): SourceAnalysis {
  const combined = evidence.map((item) => item.text).join('\n')
  const lower = combined.toLowerCase()
  const schemaKeys = extractSchemaKeys(combined)
  const mode = inferAdapterMode(lower)
  const kind = inferKind(lower, mode)
  const sensitivity = inferSensitivity(kind, lower)
  const requiresCredential = hasCredentialSignals(lower) || sensitivity !== 'public'
  const entrypoint = inferEntrypoint(combined, lower, mode, kind)
  const parserType = inferParserType(combined, schemaKeys)
  const capabilities = buildCapabilities(kind, schemaKeys)
  const missingFields = buildMissingFields(schemaKeys, entrypoint, requiresCredential, lower)
  const riskFlags = buildRiskFlags(kind, sensitivity, requiresCredential, lower)
  const title = buildTitle(kind, lower)
  const confidence = estimateConfidence({
    evidence,
    schemaKeys,
    mode,
    kind,
    hasSession: Boolean(session),
  })

  return {
    kind,
    title,
    sensitivity,
    mode,
    entrypoint,
    parserType,
    schemaKeys,
    capabilities,
    requiresCredential,
    privacy: buildPrivacy(kind, sensitivity),
    missingFields,
    riskFlags,
    confidence,
    learnedMethodSummary: buildLearnedMethodSummary(kind, mode, evidence.length),
  }
}

function buildProposedCard(
  sessionId: string,
  generatedAt: string,
  analysis: SourceAnalysis,
  evidence: CollectedEvidence[],
): SourceCard {
  const sourceId = buildSourceCardId(analysis.kind, analysis.title, sessionId)
  const revisionId = `${sourceId}-session-v1`
  const traceRefs = evidence
    .filter((item) => item.source === 'trace' || item.source === 'run_log')
    .slice(0, MAX_EVIDENCE_REFS)
    .map((item) => item.ref)
  const artifactRefs = evidence
    .filter((item) => item.source === 'artifact')
    .slice(0, MAX_EVIDENCE_REFS)
    .map((item) => item.ref)

  return {
    schemaVersion: 1,
    id: sourceId,
    title: analysis.title,
    state: 'candidate',
    kind: analysis.kind,
    owner: {
      scope:
        analysis.sensitivity === 'private' || analysis.sensitivity === 'restricted'
          ? 'user'
          : 'workspace',
    },
    sensitivity: analysis.sensitivity,
    discovery: {
      firstSeenAt: generatedAt,
      discoveredFrom: {
        sessionId,
        traceRefs,
        ...(artifactRefs.length > 0 ? { artifactRefs } : {}),
      },
      learnedMethodSummary: analysis.learnedMethodSummary,
    },
    capabilities: analysis.capabilities,
    adapter: {
      mode: analysis.mode,
      activeRevision: revisionId,
      revisions: [
        {
          id: revisionId,
          status: 'candidate',
          mode: analysis.mode,
          entrypoint: analysis.entrypoint,
          parser: {
            type: analysis.parserType,
            schemaKeys: analysis.schemaKeys,
          },
          timeoutMs: analysis.mode === 'browser' ? 60_000 : 30_000,
          validation: {
            sampleQueries: [],
            expectedEvidence: [
              'Existing session trace/run.log/messages/artifacts support this draft.',
              'No external source execution or health probe has been performed by the miner.',
            ],
          },
        },
      ],
    },
    credentials: analysis.requiresCredential
      ? [
          {
            id: 'source-access',
            required: true,
            binding: {
              type: 'none',
            },
            scopes: inferCredentialScopes(analysis.kind),
            injectAs: analysis.mode === 'browser' ? 'profileSession' : 'none',
            leasePolicy: {
              ttlSeconds: 0,
              renewable: false,
              reauthRequiredOn: ['missing_binding'],
            },
          },
        ]
      : [
          {
            id: 'public-access',
            required: false,
            binding: {
              type: 'none',
            },
            scopes: inferCredentialScopes(analysis.kind),
            injectAs: 'none',
            leasePolicy: {
              ttlSeconds: 0,
              renewable: false,
              reauthRequiredOn: [],
            },
          },
        ],
    privacy: analysis.privacy,
    health: {
      checks: [
        {
          id: 'manual_source_review',
          cadence: 'manual',
          method:
            'Manual review of the mined draft only; this MVP does not run a health probe or adapter.',
          successCriteria:
            'Reviewer confirms the session evidence, schema, privacy policy, and credential binding.',
        },
      ],
    },
    observations: {
      observationSchemaRef: `source-observation/${sourceId}-v1`,
      cursorPolicy:
        'Not inferred by Session Source Miner MVP; future Watch/adapter must define cursor ownership.',
      maxSamplePersisted: analysis.sensitivity === 'public' ? 3 : 0,
      contentHashPolicy:
        analysis.sensitivity === 'public'
          ? 'hash normalized response samples and schema keys'
          : 'metadata-only; hash identifiers and omit body or attachment content',
    },
    promotion: {
      requiredEvidence: [
        'User explicitly confirms candidate creation from this draft.',
        'Reviewer validates the proposed capability and privacy boundary.',
        'Credential binding is supplied outside the draft if required.',
        'Any dedupe candidate is resolved as new card vs adapter revision/evidence append.',
      ],
    },
  }
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
        kind: card.kind,
        sensitivity: card.sensitivity,
        score,
        reason: buildDedupeReason(proposedCard, card, score),
      }
    })
    .filter((candidate) => candidate.score >= 0.45)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
}

function buildCapabilities(kind: SourceCard['kind'], schemaKeys: string[]): SourceCardCapability[] {
  const outputProperties = Object.fromEntries(
    schemaKeys.slice(0, MAX_SCHEMA_KEYS).map((key) => [key, { type: 'unknown' }]),
  )

  if (kind === 'private_mailbox') {
    return [
      {
        id: 'list_metadata',
        operation: 'list',
        inputSchema: {
          type: 'object',
          properties: {
            folder: { type: 'string' },
            query: { type: 'string' },
            limit: { type: 'number' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: outputProperties,
        },
        watchable: true,
        defaultPrivacyScope: 'metadata_only',
        allowedActions: ['notify', 'recordObservation'],
        prohibitedActions: ['read_mail_body', 'download_attachment', 'send_mail'],
      },
    ]
  }

  if (kind === 'public_market_data') {
    return [
      {
        id: 'query_market_data',
        operation: 'query',
        inputSchema: {
          type: 'object',
          properties: {
            symbols: { type: 'array', items: { type: 'string' } },
            fields: { type: 'array', items: { type: 'string' } },
          },
        },
        outputSchema: {
          type: 'object',
          properties: outputProperties,
        },
        watchable: true,
        defaultPrivacyScope: 'public_read_only',
        allowedActions: ['notify', 'recordObservation', 'createArtifact'],
        prohibitedActions: [
          'place_order',
          'trade',
          'use_broker_account',
          'send_financial_instruction',
        ],
      },
    ]
  }

  return [
    {
      id: kind === 'local_file' ? 'read_local_metadata' : 'query_source',
      operation: kind === 'local_file' ? 'read' : 'query',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: outputProperties,
      },
      watchable: false,
      defaultPrivacyScope: 'foreground_review_required',
      allowedActions: ['recordObservation'],
      prohibitedActions: ['background_read_without_user_confirmation', 'persist_raw_private_data'],
    },
  ]
}

function buildPrivacy(
  kind: SourceCard['kind'],
  sensitivity: SourceCard['sensitivity'],
): SourceCard['privacy'] {
  if (sensitivity === 'private' || sensitivity === 'restricted') {
    return {
      dataClasses:
        kind === 'private_mailbox'
          ? ['mailbox names', 'message ids', 'bounded message metadata']
          : ['private source metadata'],
      bodyPolicy: 'metadata_only',
      attachmentPolicy: 'blocked',
      retention: {
        card: 'until user retires source',
        observations: 'metadata-only observations; default retention follows workspace policy',
        artifacts: 'explicit user-approved artifacts only',
      },
    }
  }

  if (kind === 'public_market_data') {
    return {
      dataClasses: ['public market data', 'public identifiers', 'public schema keys'],
      bodyPolicy: 'approved_background_scope',
      attachmentPolicy: 'blocked',
      retention: {
        card: 'until source revision is retired',
        observations: 'bounded public observations only',
        artifacts: 'user-visible reports or approved artifacts only',
      },
    }
  }

  return {
    dataClasses: ['session-derived source metadata'],
    bodyPolicy: 'explicit_foreground_only',
    attachmentPolicy: 'blocked',
    retention: {
      card: 'until user retires source',
      observations: 'summary observations only until reviewed',
      artifacts: 'explicit user-approved artifacts only',
    },
  }
}

function inferKind(text: string, mode: SourceCardAdapterMode): SourceCard['kind'] {
  if (/(himalaya|imap|smtp|mailbox|email|e-mail|gmail|qq\s*mail|envelope)/i.test(text)) {
    return 'private_mailbox'
  }
  if (/(stock|market|quote|eastmoney|akshare|tushare|ticker|symbol|证券|股票|行情)/i.test(text)) {
    return 'public_market_data'
  }
  if (mode === 'browser') return 'browser_session'
  if (mode === 'direct') return 'local_file'
  return 'web_api'
}

function inferAdapterMode(text: string): SourceCardAdapterMode {
  if (/(browser|playwright|page\.|click|screenshot)/i.test(text)) return 'browser'
  if (/(himalaya|bash|command|cli|bunx|npx|python|akshare|tushare)/i.test(text)) return 'cli'
  if (/(fetch|http|api|endpoint|statuscode|status code)/i.test(text)) return 'api'
  if (/(local_file|read tool|write tool|\.csv|\.json|\.xlsx|\.artifacts)/i.test(text)) {
    return 'direct'
  }
  return 'api'
}

function inferSensitivity(kind: SourceCard['kind'], text: string): SourceCard['sensitivity'] {
  if (kind === 'private_mailbox') return 'private'
  if (/(authorization|cookie|password|token|secret|oauth|credential)/i.test(text)) {
    return 'restricted'
  }
  if (kind === 'public_market_data') return 'public'
  return 'internal'
}

function inferEntrypoint(
  text: string,
  lower: string,
  mode: SourceCardAdapterMode,
  kind: SourceCard['kind'],
): string {
  if (kind === 'private_mailbox' && /himalaya/i.test(lower)) return 'himalaya'
  const urls = text.match(URL_RE)
  if (urls?.[0]) {
    try {
      return new URL(urls[0]).origin
    } catch {
      return urls[0]
    }
  }
  if (mode === 'browser') return 'browser-session'
  if (mode === 'direct') return 'local-session-artifact'
  return `${kind}-session-evidence`
}

function inferParserType(
  text: string,
  schemaKeys: string[],
): SourceCard['adapter']['revisions'][number]['parser']['type'] {
  if (/<html|<!doctype/i.test(text)) return 'html'
  if (schemaKeys.length > 0 || /[{[]/.test(text)) return 'json'
  if (/^[^,\n]+,[^,\n]+/m.test(text)) return 'csv'
  return 'text'
}

function inferCredentialScopes(kind: SourceCard['kind']): string[] {
  if (kind === 'private_mailbox') return ['mail.metadata.read']
  if (kind === 'public_market_data') return ['market.public.read']
  if (kind === 'browser_session') return ['browser.session.foreground']
  if (kind === 'local_file') return ['local.file.read']
  return ['source.metadata.read']
}

function hasCredentialSignals(text: string): boolean {
  return /(authorization|cookie|password|token|secret|oauth|credential|api[_-]?key|vault:\/\/|external:)/i.test(
    text,
  )
}

function buildMissingFields(
  schemaKeys: string[],
  entrypoint: string,
  requiresCredential: boolean,
  text: string,
): string[] {
  const missing = new Set<string>()
  if (schemaKeys.length === 0) missing.add('schemaKeys')
  if (/session-evidence$/.test(entrypoint)) missing.add('adapter.entrypoint')
  if (requiresCredential) missing.add('credential.binding')
  if (!/(timeout|duration|statuscode|exitcode|exit code|rowcount|schema)/i.test(text)) {
    missing.add('validation.expectedEvidence')
  }
  return [...missing]
}

function buildRiskFlags(
  kind: SourceCard['kind'],
  sensitivity: SourceCard['sensitivity'],
  requiresCredential: boolean,
  text: string,
): string[] {
  const flags = new Set<string>([
    'Draft only: no Source Card has been activated.',
    'Session Source Miner MVP did not execute CLI/API/browser/fetch or health probes.',
  ])
  if (sensitivity === 'private' || sensitivity === 'restricted') {
    flags.add('Private/restricted source defaults to metadata-only with attachments blocked.')
  }
  if (requiresCredential) {
    flags.add(
      'Credential binding was only inferred; no credential reference is stored in the draft.',
    )
  }
  if (kind === 'public_market_data') {
    flags.add('Market-data draft is read-only; trading or broker actions remain prohibited.')
  }
  if (/(authorization|cookie|password|token|secret|credentialRef|credentialLeaseId)/i.test(text)) {
    flags.add('Sensitive evidence was redacted before draft output.')
  }
  return [...flags]
}

function buildTitle(kind: SourceCard['kind'], text: string): string {
  if (kind === 'private_mailbox' && /himalaya/i.test(text)) return 'Mined QQ Mail via himalaya CLI'
  if (kind === 'private_mailbox') return 'Mined Mailbox Metadata Source'
  if (kind === 'public_market_data' && /eastmoney/i.test(text)) {
    return 'Mined Eastmoney Market Data Source'
  }
  if (kind === 'public_market_data') return 'Mined Public Market Data Source'
  if (kind === 'browser_session') return 'Mined Browser Session Source'
  if (kind === 'local_file') return 'Mined Local File Source'
  return 'Mined Web API Source'
}

function buildLearnedMethodSummary(
  kind: SourceCard['kind'],
  mode: SourceCardAdapterMode,
  evidenceCount: number,
): string {
  const source = kind.replaceAll('_', ' ')
  return `Inferred ${source} access through ${mode} evidence from ${evidenceCount} existing session evidence item(s). No external source was re-read by the miner.`
}

function estimateConfidence(input: {
  evidence: CollectedEvidence[]
  schemaKeys: string[]
  mode: SourceCardAdapterMode
  kind: SourceCard['kind']
  hasSession: boolean
}): number {
  let confidence = input.hasSession ? 0.24 : 0.12
  confidence += Math.min(0.22, input.evidence.length * 0.025)
  confidence += Math.min(0.18, input.schemaKeys.length * 0.025)
  if (input.mode) confidence += 0.12
  if (input.kind !== 'web_api') confidence += 0.14
  return Math.min(0.92, Number(confidence.toFixed(2)))
}

function extractSchemaKeys(text: string): string[] {
  const keys = new Set<string>()
  const keyRe = /"([A-Za-z_][A-Za-z0-9_-]{1,48})"\s*:/g
  let match = keyRe.exec(text)
  while (match) {
    const key = match[1]
    match = keyRe.exec(text)
    if (SENSITIVE_KEY_RE.test(key)) continue
    if (PRIVATE_CONTENT_KEY_RE.test(key)) continue
    if (COMMON_JSON_KEYS.has(key)) continue
    keys.add(key)
  }
  return [...keys].slice(0, MAX_SCHEMA_KEYS)
}

function extractArtifactRefs(text: string): string[] {
  const refs = new Set<string>()
  let match = ARTIFACT_PATH_RE.exec(text)
  while (match) {
    refs.add(match[1])
    match = ARTIFACT_PATH_RE.exec(text)
  }
  return [...refs].slice(0, MAX_EVIDENCE_REFS)
}

function evidenceScore(text: string): number {
  let score = 0
  if (/(tool_use|tool_call|tool_result)/i.test(text)) score += 2
  if (/(himalaya|eastmoney|api|fetch|stock|mail|schema|statuscode|exitcode)/i.test(text)) {
    score += 2
  }
  if (/(authorization|cookie|password|token|credential)/i.test(text)) score += 1
  return score
}

function summarizeEvidenceText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 180) return normalized
  return `${normalized.slice(0, 177)}...`
}

function summarizePrivateEvidenceMetadata(item: CollectedEvidence): string {
  const text = item.text
  const signals = new Set<string>()
  if (/tool_use/i.test(text)) signals.add('tool use')
  if (/tool_result|toolResult|raw_result/i.test(text)) signals.add('tool result')
  if (/schemaKeys|"schemaKeys"|schema keys/i.test(text) || extractSchemaKeys(text).length > 0) {
    signals.add('schema keys')
  }
  if (/https?:\/\//i.test(text)) signals.add('endpoint signal')
  if (/himalaya/i.test(text)) signals.add('cli:himalaya')
  if (/(bash|command|cli)/i.test(text)) signals.add('cli signal')
  if (/\[REDACTED|REDACTED_SECRET|REDACTED_CREDENTIAL_REFERENCE/i.test(text)) {
    signals.add('redaction applied')
  }
  if (/\[TRUNCATED]/i.test(text)) signals.add('truncated evidence')

  const signalList = [...signals]
  return `${item.source} evidence; metadata-only summary; signals: ${
    signalList.length > 0 ? signalList.join(', ') : 'none'
  }`
}

function truncateEvidenceText(text: string): string {
  if (text.length <= MAX_EVIDENCE_TEXT_CHARS) return text
  return `${text.slice(0, MAX_EVIDENCE_TEXT_CHARS)} [TRUNCATED]`
}

function buildSourceCardId(kind: SourceCard['kind'], title: string, sessionId: string): string {
  const suffix = sessionId
    .replace(/^sess_?/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .slice(-20)
  const titleSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36)
  return `mined-${kind.replaceAll('_', '-')}-${titleSlug || 'source'}-${suffix || 'session'}`
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function scoreDedupe(proposedCard: SourceCard, existing: SourceCardDedupeSource): number {
  let score = 0
  if (proposedCard.kind === existing.kind) score += 0.34
  if (proposedCard.sensitivity === existing.sensitivity) score += 0.08
  if (proposedCard.adapter.mode === existing.adapter?.mode) score += 0.1

  const proposedTokens = tokenSet(
    `${proposedCard.title} ${proposedCard.kind} ${proposedCard.capabilities
      .map((item) => item.id)
      .join(' ')}`,
  )
  const existingTokens = tokenSet(
    `${existing.title} ${existing.kind} ${(existing.capabilities ?? [])
      .map((item) => item.id)
      .join(' ')}`,
  )
  score += jaccard(proposedTokens, existingTokens) * 0.48
  return Number(Math.min(0.99, score).toFixed(2))
}

function buildDedupeReason(
  proposedCard: SourceCard,
  existing: SourceCardDedupeSource,
  score: number,
): string {
  const matches = [
    proposedCard.kind === existing.kind ? 'kind' : undefined,
    proposedCard.adapter.mode === existing.adapter?.mode ? 'adapter mode' : undefined,
    proposedCard.sensitivity === existing.sensitivity ? 'sensitivity' : undefined,
  ].filter(Boolean)
  return `Potential match on ${matches.join(', ') || 'title/capability tokens'} (score ${score}).`
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  )
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) {
    if (right.has(token)) intersection += 1
  }
  return intersection / (left.size + right.size - intersection)
}

function redactStrict(value: unknown, secretFilter?: SecretFilter, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEY_RE.test(key)) return '[REDACTED]'
    return redactStrictText(value, secretFilter)
  }

  if (Array.isArray(value)) return value.map((item) => redactStrict(item, secretFilter, key))

  const record = asRecord(value)
  if (!record) return value

  return Object.fromEntries(
    Object.entries(record).map(([nestedKey, nestedValue]) => [
      nestedKey,
      redactStrict(nestedValue, secretFilter, nestedKey),
    ]),
  )
}

function redactStrictText(value: string, secretFilter?: SecretFilter): string {
  const filtered = secretFilter ? secretFilter.filter(value) : value
  return filtered
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(authorization|cookie|password|token|secret|api[_-]?key)=([^&\s]+)/gi,
      '[REDACTED_SECRET]',
    )
    .replace(
      /(authorization|cookie|password|token|secret|api[_-]?key):\s*([^\n]+)/gi,
      '[REDACTED_SECRET]',
    )
    .replace(
      /"(authorization|cookie|password|token|secret|api[_-]?key)"\s*:\s*"[^"]*"/gi,
      '"[REDACTED_SECRET]"',
    )
    .replace(/"(credentialRef|credentialLeaseId)"\s*:\s*"[^"]*"/gi, '"[REDACTED_SECRET]"')
    .replace(/\b(credentialRef|credentialLeaseId)\b/gi, '[REDACTED_CREDENTIAL_REFERENCE]')
    .replace(/(vault:\/\/|external:)[^\s"',}]+/gi, '[REDACTED_SECRET]')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

const COMMON_JSON_KEYS = new Set([
  'data',
  'metadata',
  'input',
  'output',
  'result',
  'status',
  'success',
  'error',
  'message',
  'content',
  'type',
  'tool',
  'toolUseId',
  'toolName',
  'traceSpanId',
  'requestId',
  'spanData',
])

const STOP_WORDS = new Set([
  'mined',
  'source',
  'data',
  'card',
  'via',
  'the',
  'and',
  'from',
  'with',
  'for',
])
