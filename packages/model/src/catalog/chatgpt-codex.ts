import { createHash } from 'node:crypto'
import {
  type ProviderConfig,
  type ReasoningEffort,
  normalizeReasoningEffort,
} from '@zero-os/shared'
import { ResponsesStreamError, iterResponsesSseEvents } from '../adapters/openai-resp-stream'
import {
  type ChatGptOAuthSession,
  getChatGptAuthorizationScheme,
  parseChatGptOAuthSession,
} from '../auth/chatgpt'
import type {
  DiscoveredModel,
  ModelCatalogFieldSource,
  ModelDiscoveryContext,
  ModelDiscoveryDriver,
  ModelDiscoveryResult,
  ModelDiscoveryScope,
  ModelVerificationResult,
} from './types'

const DEFAULT_MAX_OUTPUT = 8192

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class ChatGptCodexDiscoveryDriver implements ModelDiscoveryDriver {
  readonly kind = 'chatgpt-codex'
  readonly defaultEnabled = true

  constructor(private readonly fetcher: Fetcher = fetch) {}

  supports(providerName: string, provider: ProviderConfig): boolean {
    const managedKind = provider.auth.managedOAuthProvider
    const isChatGpt = managedKind === 'chatgpt' || providerName === 'chatgpt'
    return (
      isChatGpt &&
      provider.apiType === 'openai_responses' &&
      normalizeBaseUrl(provider.baseUrl).endsWith('/backend-api/codex')
    )
  }

  resolveScope(context: Omit<ModelDiscoveryContext, 'signal'>): ModelDiscoveryScope | undefined {
    const session = readSession(context.provider, context.secretGetter)
    if (!session) return undefined
    return buildScope(context.providerName, context.provider, session)
  }

  async discover(context: ModelDiscoveryContext): Promise<ModelDiscoveryResult> {
    const session = requireSession(context.provider, context.secretGetter)
    const scope = buildScope(context.providerName, context.provider, session)
    const clientVersion =
      context.provider.discovery?.clientVersion ??
      process.env.ZERO_CHATGPT_CODEX_CLIENT_VERSION ??
      currentClientVersion()
    const url = new URL(`${normalizeBaseUrl(context.provider.baseUrl)}/models`)
    url.searchParams.set('client_version', clientVersion)

    const response = await this.fetcher(url, {
      headers: buildHeaders(session, 'application/json'),
      signal: context.signal,
    })
    if (!response.ok) {
      throw new Error(`ChatGPT Codex model discovery failed with HTTP ${response.status}`)
    }

    const payload = (await response.json()) as unknown
    return {
      scope,
      models: parseChatGptCodexModels(payload),
    }
  }

  async verify(
    context: ModelDiscoveryContext,
    _scope: ModelDiscoveryScope,
    model: DiscoveredModel,
  ): Promise<ModelVerificationResult> {
    const session = requireSession(context.provider, context.secretGetter)
    const response = await this.fetcher(`${normalizeBaseUrl(context.provider.baseUrl)}/responses`, {
      method: 'POST',
      headers: {
        ...buildHeaders(session, 'text/event-stream'),
        'OpenAI-Beta': 'responses=experimental',
        originator: 'zero-os-model-catalog',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model.modelId,
        store: false,
        stream: true,
        instructions: 'Reply with OK.',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'Reply with OK.' }],
          },
        ],
        text: { verbosity: 'low' },
        service_tier: 'priority',
      }),
      signal: context.signal,
    })

    if (response.ok) {
      try {
        for await (const event of iterResponsesSseEvents(response, {
          requireCompleted: true,
          signal: context.signal,
        })) {
          if (event.type === 'response.completed') return { ok: true }
        }
      } catch (error) {
        if (isModelUnavailableStreamError(error)) {
          return {
            ok: false,
            reason:
              error instanceof ResponsesStreamError && error.error_type
                ? error.error_type
                : 'response_model_unavailable',
          }
        }
        throw error
      }
      throw new Error('ChatGPT Codex model verification ended without response.completed')
    }
    await response.body?.cancel().catch(() => {})
    if (response.status === 400 || response.status === 404) {
      return { ok: false, reason: `http_${response.status}` }
    }
    throw new Error(`ChatGPT Codex model verification failed with HTTP ${response.status}`)
  }
}

function isModelUnavailableStreamError(error: unknown): boolean {
  const errorType =
    error instanceof ResponsesStreamError ? (error.error_type ?? '').toLowerCase() : ''
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    errorType === 'model_not_found' ||
    errorType === 'unsupported_model' ||
    errorType === 'invalid_model' ||
    /model .*?(?:not found|does not exist|is unavailable|is not supported|is unsupported)/.test(
      message,
    )
  )
}

export function parseChatGptCodexModels(payload: unknown): DiscoveredModel[] {
  const rawModels = extractModelList(payload)
  const parsed = rawModels.flatMap((value) => {
    const model = parseModel(value)
    return model ? [model] : []
  })

  return Array.from(new Map(parsed.map((model) => [model.modelId, model])).values())
}

function parseModel(value: unknown): DiscoveredModel | undefined {
  if (!isRecord(value)) return undefined
  const modelId = readString(value, 'slug', 'id', 'model')
  if (!modelId) return undefined

  const identity = inferIdentity(modelId)
  const supportedReasoningEfforts = parseReasoningEfforts(value.supported_reasoning_levels)
  const defaultReasoningEffort = normalizeReasoningEffort(
    readString(value, 'default_reasoning_level'),
  )
  const capabilities = inferCapabilities(value, supportedReasoningEfforts)
  const maxContext = readPositiveInteger(value, 'max_context_window', 'context_window')
  const maxOutput =
    readPositiveInteger(value, 'max_output_tokens', 'max_output') ?? DEFAULT_MAX_OUTPUT
  const provenance: Record<string, ModelCatalogFieldSource> = {
    modelId: 'provider',
    maxOutput: readPositiveInteger(value, 'max_output_tokens', 'max_output')
      ? 'provider'
      : 'system_default',
    capabilities: 'provider',
  }
  if (maxContext) provenance.maxContext = 'provider'
  if (supportedReasoningEfforts.length) provenance.supportedReasoningEfforts = 'provider'
  if (defaultReasoningEffort) provenance.defaultReasoningEffort = 'provider'

  return {
    modelName: modelId,
    modelId,
    displayName: readString(value, 'display_name', 'name'),
    description: readString(value, 'description'),
    family: identity.family,
    version: identity.version,
    lane: identity.lane,
    maxContext,
    maxOutput,
    capabilities,
    tags: buildTags(identity, capabilities),
    defaultReasoningEffort,
    supportedReasoningEfforts,
    provenance,
  }
}

function extractModelList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []
  if (Array.isArray(payload.models)) return payload.models
  if (Array.isArray(payload.data)) return payload.data
  return []
}

function parseReasoningEfforts(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value)) return []
  const efforts = value
    .map((item) => {
      if (typeof item === 'string') return normalizeReasoningEffort(item)
      if (!isRecord(item)) return undefined
      return normalizeReasoningEffort(readString(item, 'effort', 'reasoning_effort'))
    })
    .filter((effort): effort is ReasoningEffort => effort !== undefined)
  return Array.from(new Set(efforts))
}

function inferCapabilities(
  value: Record<string, unknown>,
  reasoningEfforts: ReasoningEffort[],
): string[] {
  const capabilities = new Set<string>()
  const modalities = readStringArray(value, 'input_modalities')
  const toolSignals = [
    value.apply_patch_tool_type,
    value.web_search_tool_type,
    value.supports_function_calling,
    value.supports_tools,
  ]

  if (toolSignals.some(Boolean)) capabilities.add('tools')
  if (modalities.some((modality) => modality === 'image')) capabilities.add('vision')
  if (reasoningEfforts.length > 0 || value.reasoning_summary_format) {
    capabilities.add('reasoning')
  }
  return Array.from(capabilities)
}

function inferIdentity(modelId: string): { family?: string; version?: string; lane?: string } {
  const match = modelId.match(/^([a-z][a-z0-9]*)-(\d+(?:\.\d+)*)(?:-(.+))?$/i)
  if (!match) return {}
  return {
    family: match[1].toLowerCase(),
    version: match[2],
    lane: match[3]?.toLowerCase(),
  }
}

function buildTags(
  identity: { family?: string; version?: string; lane?: string },
  capabilities: string[],
): string[] {
  return Array.from(
    new Set(
      ['codex', identity.family, identity.version, identity.lane, ...capabilities].filter(
        (tag): tag is string => Boolean(tag),
      ),
    ),
  )
}

function readSession(
  provider: ProviderConfig,
  secretGetter: (ref: string) => string | undefined,
): ChatGptOAuthSession | null {
  const ref = provider.auth.oauthTokenRef
  return ref ? parseChatGptOAuthSession(secretGetter(ref)) : null
}

function requireSession(
  provider: ProviderConfig,
  secretGetter: (ref: string) => string | undefined,
): ChatGptOAuthSession {
  const session = readSession(provider, secretGetter)
  if (!session) throw new Error('ChatGPT OAuth session is not configured for model discovery')
  return session
}

function buildScope(
  providerName: string,
  provider: ProviderConfig,
  session: ChatGptOAuthSession,
): ModelDiscoveryScope {
  return {
    providerName,
    providerKind: 'chatgpt',
    accountFingerprint: fingerprint(session.accountId || session.accessToken),
    transport: `openai_responses:${normalizeBaseUrl(provider.baseUrl)}`,
    apiType: provider.apiType,
  }
}

function buildHeaders(session: ChatGptOAuthSession, accept: string): Record<string, string> {
  return {
    Authorization: `${getChatGptAuthorizationScheme(session.tokenType)} ${session.accessToken}`,
    'chatgpt-account-id': session.accountId,
    accept,
  }
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function currentClientVersion(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.0`
}

function readString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const field = value[key]
    if (typeof field === 'string' && field.trim()) return field.trim()
  }
  return undefined
}

function readStringArray(value: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const field = value[key]
    if (Array.isArray(field)) {
      return field.filter((item): item is string => typeof item === 'string')
    }
  }
  return []
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
