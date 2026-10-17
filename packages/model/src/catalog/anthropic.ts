import { createHash } from 'node:crypto'
import {
  type ProviderConfig,
  type ReasoningEffort,
  normalizeReasoningEffort,
} from '@zero-os/shared'
import { CLAUDE_CODE_SYSTEM_PROMPT, buildClaudeCodeOAuthHeaders } from '../adapters/anthropic'
import { type ClaudeOAuthSession, parseClaudeOAuthSession } from '../auth/claude'
import type {
  DiscoveredModel,
  ModelCatalogFieldSource,
  ModelDiscoveryContext,
  ModelDiscoveryDriver,
  ModelDiscoveryResult,
  ModelDiscoveryScope,
  ModelVerificationResult,
} from './types'

const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_API_HOST = 'https://api.anthropic.com'
const MODELS_PAGE_LIMIT = 1000
const MAX_MODEL_PAGES = 20
const DEFAULT_MAX_CONTEXT = 200_000
const DEFAULT_MAX_OUTPUT = 8192
const VERIFY_MAX_TOKENS = 8
const CLAUDE_TIERS = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'] as const

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Credentials resolved for one discovery call; never persisted or logged. */
type AnthropicCredential =
  | { kind: 'oauth'; session: ClaudeOAuthSession }
  | { kind: 'api_key'; apiKey: string }

/**
 * Discovers Claude models through the Anthropic Models API (`GET /v1/models`)
 * and verifies each one with a minimal Messages call on the same transport the
 * runtime adapter uses, so the catalog only activates models this account can
 * actually complete against.
 */
export class AnthropicModelsDiscoveryDriver implements ModelDiscoveryDriver {
  readonly kind = 'anthropic-models'
  readonly defaultEnabled = true

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly refreshAuth?: (
      context: ModelDiscoveryContext,
      reason: 'expiring' | 'unauthorized',
    ) => Promise<void>,
  ) {}

  supports(providerName: string, provider: ProviderConfig): boolean {
    if (provider.apiType !== 'anthropic_messages') return false
    const managedKind = provider.auth.managedOAuthProvider
    const isAnthropicKind =
      managedKind === 'anthropic' ||
      providerName === 'anthropic' ||
      providerName.startsWith('anthropic-')
    return isAnthropicKind || normalizeBaseUrl(provider.baseUrl).startsWith(ANTHROPIC_API_HOST)
  }

  resolveScope(context: Omit<ModelDiscoveryContext, 'signal'>): ModelDiscoveryScope | undefined {
    const credential = readCredential(context.provider, context.secretGetter)
    if (!credential) return undefined
    return buildScope(context.providerName, context.provider, credential)
  }

  async discover(context: ModelDiscoveryContext): Promise<ModelDiscoveryResult> {
    const credential = requireCredential(context.provider, context.secretGetter)
    const scope = buildScope(context.providerName, context.provider, credential)
    const baseUrl = normalizeBaseUrl(context.provider.baseUrl)
    const models: DiscoveredModel[] = []
    let afterId: string | undefined

    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const url = new URL(`${baseUrl}/v1/models`)
      url.searchParams.set('limit', String(MODELS_PAGE_LIMIT))
      if (afterId) url.searchParams.set('after_id', afterId)

      const response = await this.authenticatedRequest(context, (credential) =>
        this.fetcher(withTransportQuery(url, credential), {
          headers: buildHeaders(credential, 'application/json'),
          signal: context.signal,
        }),
      )
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`Anthropic model discovery failed with HTTP ${response.status}`)
      }

      const payload = (await response.json()) as unknown
      models.push(...parseAnthropicModels(payload, { authKind: credential.kind }))

      const paging = readPaging(payload)
      if (!paging.hasMore || !paging.lastId || paging.lastId === afterId) break
      afterId = paging.lastId
    }

    return {
      scope,
      models: Array.from(new Map(models.map((model) => [model.modelId, model])).values()),
    }
  }

  async verify(
    context: ModelDiscoveryContext,
    _scope: ModelDiscoveryScope,
    model: DiscoveredModel,
  ): Promise<ModelVerificationResult> {
    const baseUrl = normalizeBaseUrl(context.provider.baseUrl)
    const response = await this.authenticatedRequest(context, (credential) =>
      this.fetcher(withTransportQuery(new URL(`${baseUrl}/v1/messages`), credential), {
        method: 'POST',
        headers: {
          ...buildHeaders(credential, 'application/json'),
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildVerificationRequest(model.modelId, credential)),
        signal: context.signal,
      }),
    )

    if (response.ok) {
      await response.body?.cancel().catch(() => {})
      return { ok: true }
    }

    const failure = await readErrorBody(response)
    if (response.status === 404 || response.status === 403) {
      return { ok: false, reason: failure.type ?? `http_${response.status}` }
    }
    if (response.status === 400 && isModelRejection(failure)) {
      return { ok: false, reason: failure.type ?? 'http_400' }
    }
    throw new Error(
      `Anthropic model verification failed with HTTP ${response.status}${
        failure.type ? ` (${failure.type})` : ''
      }`,
    )
  }

  private async authenticatedRequest(
    context: ModelDiscoveryContext,
    request: (credential: AnthropicCredential) => Promise<Response>,
  ): Promise<Response> {
    const original = requireCredential(context.provider, context.secretGetter)
    if (original.kind === 'oauth') await this.refreshAuth?.(context, 'expiring')
    context.signal.throwIfAborted()
    const current = requireCredential(context.provider, context.secretGetter)
    let response = await request(current)
    if (response.status === 401 && current.kind === 'oauth' && this.refreshAuth) {
      await response.body?.cancel().catch(() => {})
      await this.refreshAuth(context, 'unauthorized')
      context.signal.throwIfAborted()
      const refreshed = requireCredential(context.provider, context.secretGetter)
      if (
        buildScope(context.providerName, context.provider, current).accountFingerprint !==
        buildScope(context.providerName, context.provider, refreshed).accountFingerprint
      ) {
        throw new Error('Model discovery account changed during authentication refresh')
      }
      response = await request(refreshed)
    }
    return response
  }
}

export interface ParseAnthropicModelsOptions {
  authKind?: 'oauth' | 'api_key'
}

export function parseAnthropicModels(
  payload: unknown,
  options: ParseAnthropicModelsOptions = {},
): DiscoveredModel[] {
  const rawModels = extractModelList(payload)
  const parsed = rawModels.flatMap((value) => {
    const model = parseModel(value, options)
    return model ? [model] : []
  })
  return Array.from(new Map(parsed.map((model) => [model.modelId, model])).values())
}

function parseModel(
  value: unknown,
  options: ParseAnthropicModelsOptions,
): DiscoveredModel | undefined {
  if (!isRecord(value)) return undefined
  if (value.type !== undefined && value.type !== 'model') return undefined
  const modelId = readString(value, 'id')
  if (!modelId) return undefined

  const identity = inferIdentity(modelId)
  const rawCapabilities = isRecord(value.capabilities) ? value.capabilities : undefined
  const capabilities = rawCapabilities
    ? readCapabilities(rawCapabilities)
    : inferCapabilities(identity)
  const supportedReasoningEfforts = rawCapabilities ? readReasoningEfforts(rawCapabilities) : []
  const maxContext = readPositiveInteger(value, 'max_input_tokens')
  const maxOutput = readPositiveInteger(value, 'max_tokens')

  const provenance: Record<string, ModelCatalogFieldSource> = {
    modelId: 'provider',
    maxContext: maxContext ? 'provider' : 'system_default',
    maxOutput: maxOutput ? 'provider' : 'system_default',
    capabilities: rawCapabilities ? 'provider' : 'system_default',
  }
  if (supportedReasoningEfforts.length) provenance.supportedReasoningEfforts = 'provider'

  return {
    modelName: modelId,
    modelId,
    displayName: readString(value, 'display_name'),
    family: identity.family,
    version: identity.version,
    lane: identity.lane,
    maxContext: maxContext ?? DEFAULT_MAX_CONTEXT,
    maxOutput: maxOutput ?? DEFAULT_MAX_OUTPUT,
    capabilities,
    tags: buildTags(identity, capabilities, options.authKind),
    supportedReasoningEfforts,
    provenance,
  }
}

function extractModelList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []
  if (Array.isArray(payload.data)) return payload.data
  if (Array.isArray(payload.models)) return payload.models
  return []
}

function readPaging(payload: unknown): { hasMore: boolean; lastId?: string } {
  if (!isRecord(payload)) return { hasMore: false }
  return {
    hasMore: payload.has_more === true,
    lastId: readString(payload, 'last_id'),
  }
}

interface ClaudeIdentity {
  family?: string
  version?: string
  lane?: string
  majorVersion?: number
}

/**
 * Normalizes both current (`claude-opus-4-8`, `claude-fable-5-1`) and legacy
 * (`claude-3-5-sonnet-20241022`) id shapes into family=claude, lane=tier and a
 * dotted version so routes can select by `family`, `lanes` and `prefer: newest`.
 */
function inferIdentity(modelId: string): ClaudeIdentity {
  const id = modelId.toLowerCase().replace(/-\d{8}$/, '')
  const tiers = CLAUDE_TIERS.join('|')
  const modern = id.match(new RegExp(`^claude-(${tiers})-(\\d+)(?:-(\\d+))?(?:-.+)?$`))
  const legacy = id.match(new RegExp(`^claude-(\\d+)(?:-(\\d+))?-(${tiers})(?:-.+)?$`))
  const match = modern
    ? { tier: modern[1], major: modern[2], minor: modern[3] }
    : legacy
      ? { tier: legacy[3], major: legacy[1], minor: legacy[2] }
      : undefined
  if (!match) return id.startsWith('claude-') ? { family: 'claude' } : {}
  return {
    family: 'claude',
    lane: match.tier,
    version: match.minor ? `${match.major}.${match.minor}` : match.major,
    majorVersion: Number(match.major),
  }
}

function readCapabilities(capabilities: Record<string, unknown>): string[] {
  const result = new Set<string>(['tools'])
  if (isSupported(capabilities.image_input) || isSupported(capabilities.pdf_input)) {
    result.add('vision')
  }
  if (isSupported(capabilities.thinking)) result.add('reasoning')
  return Array.from(result)
}

function inferCapabilities(identity: ClaudeIdentity): string[] {
  const capabilities = ['tools', 'vision']
  const version = Number.parseFloat(identity.version ?? '')
  if (Number.isFinite(version) && version >= 3.7) capabilities.push('reasoning')
  return capabilities
}

function readReasoningEfforts(capabilities: Record<string, unknown>): ReasoningEffort[] {
  const effort = capabilities.effort
  if (!isRecord(effort) || !isSupported(effort)) return []
  const efforts = Object.entries(effort)
    .filter(([key, leaf]) => key !== 'supported' && isSupported(leaf))
    .map(([key]) => normalizeReasoningEffort(key))
    .filter((value): value is ReasoningEffort => value !== undefined)
  return Array.from(new Set(efforts))
}

function isSupported(value: unknown): boolean {
  return isRecord(value) && value.supported === true
}

function buildTags(
  identity: ClaudeIdentity,
  capabilities: string[],
  authKind?: 'oauth' | 'api_key',
): string[] {
  return Array.from(
    new Set(
      [
        'anthropic',
        identity.family,
        identity.lane,
        identity.version,
        ...capabilities,
        authKind === 'oauth' ? 'oauth' : undefined,
      ].filter((tag): tag is string => Boolean(tag)),
    ),
  )
}

function buildVerificationRequest(
  modelId: string,
  credential: AnthropicCredential,
): Record<string, unknown> {
  return {
    model: modelId,
    max_tokens: VERIFY_MAX_TOKENS,
    ...(credential.kind === 'oauth'
      ? { system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }] }
      : {}),
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  }
}

interface AnthropicErrorBody {
  type?: string
  message?: string
}

async function readErrorBody(response: Response): Promise<AnthropicErrorBody> {
  try {
    const payload = (await response.json()) as unknown
    if (!isRecord(payload)) return {}
    const error = isRecord(payload.error) ? payload.error : payload
    return {
      type: readString(error, 'type'),
      message: readString(error, 'message'),
    }
  } catch {
    return {}
  }
}

function isModelRejection(failure: AnthropicErrorBody): boolean {
  if (failure.type === 'not_found_error') return true
  const message = failure.message?.toLowerCase() ?? ''
  // Client-version gating ("Claude Code X does not support this model") is a
  // per-model rejection: other models on the account remain verifiable.
  if (/does not support this model/.test(message)) return true
  return (
    /\bmodel\b/.test(message) &&
    /not found|does not exist|unsupported|not supported|invalid|deprecated|retired/.test(message)
  )
}

function readCredential(
  provider: ProviderConfig,
  secretGetter: (ref: string) => string | undefined,
): AnthropicCredential | null {
  if (provider.auth.type === 'oauth2') {
    const ref = provider.auth.oauthTokenRef
    const session = ref ? parseClaudeOAuthSession(secretGetter(ref)) : null
    return session ? { kind: 'oauth', session } : null
  }
  const ref = provider.auth.apiKeyRef
  const apiKey = ref ? secretGetter(ref)?.trim() : undefined
  return apiKey ? { kind: 'api_key', apiKey } : null
}

function requireCredential(
  provider: ProviderConfig,
  secretGetter: (ref: string) => string | undefined,
): AnthropicCredential {
  const credential = readCredential(provider, secretGetter)
  if (!credential) {
    throw new Error('Anthropic credentials are not configured for model discovery')
  }
  return credential
}

function buildScope(
  providerName: string,
  provider: ProviderConfig,
  credential: AnthropicCredential,
): ModelDiscoveryScope {
  return {
    providerName,
    providerKind: 'anthropic',
    accountFingerprint: fingerprint(accountIdentity(provider, credential)),
    transport: `anthropic_messages:${normalizeBaseUrl(provider.baseUrl)}`,
    apiType: provider.apiType,
  }
}

/**
 * Access tokens rotate on refresh, so the fingerprint must come from a stable
 * account identifier. Sessions without profile data fall back to the secret
 * ref, which identifies the provider instance's credential slot.
 */
function accountIdentity(provider: ProviderConfig, credential: AnthropicCredential): string {
  if (credential.kind === 'api_key') return `api_key:${credential.apiKey}`
  const account = credential.session.account
  const stable = account?.accountUuid ?? account?.organizationUuid ?? account?.emailAddress
  return `oauth:${stable ?? provider.auth.oauthTokenRef ?? credential.session.accessToken}`
}

function buildHeaders(credential: AnthropicCredential, accept: string): Record<string, string> {
  const base =
    credential.kind === 'oauth'
      ? buildClaudeCodeOAuthHeaders(credential.session.accessToken)
      : { 'x-api-key': credential.apiKey }
  return { ...base, 'anthropic-version': ANTHROPIC_VERSION, accept }
}

function withTransportQuery(url: URL, credential: AnthropicCredential): URL {
  if (credential.kind === 'oauth') url.searchParams.set('beta', 'true')
  return url
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function readString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const field = value[key]
    if (typeof field === 'string' && field.trim()) return field.trim()
  }
  return undefined
}

function readPositiveInteger(
  value: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const field = value[key]
    if (typeof field === 'number' && Number.isFinite(field) && field > 0) {
      return Math.floor(field)
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
