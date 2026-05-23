import type { ToolContext, ToolResult } from '@zero-os/shared'
import { BaseTool } from './base'

export interface XSearchCredential {
  bearerToken: string
  authorizationScheme?: string
  baseUrl?: string
  source?: string
}

export type XSearchCredentialProvider = (
  ctx: ToolContext,
) => Promise<XSearchCredential | undefined> | XSearchCredential | undefined

interface XSearchInput {
  query: string
  allowed_x_handles?: string[]
  excluded_x_handles?: string[]
  from_date?: string
  to_date?: string
  enable_image_understanding?: boolean
  enable_video_understanding?: boolean
  model?: string
}

interface XSearchToolOptions {
  credentialProvider?: XSearchCredentialProvider
  fetchFn?: typeof fetch
  defaultBaseUrl?: string
  defaultModel?: string
  timeoutMs?: number
  maxRetries?: number
}

const DEFAULT_XAI_BASE_URL = 'https://api.x.ai/v1'
const DEFAULT_X_SEARCH_MODEL = 'grok-4.20-reasoning'
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_MAX_RETRIES = 2
const MAX_HANDLES = 10

export class XSearchTool extends BaseTool {
  kind = 'built-in' as const
  name = 'x_search'
  description =
    "Search X (Twitter) posts, profiles, and threads using xAI's built-in x_search Responses tool. Use this for current discussion, reactions, or claims on X rather than general web pages."
  parameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to look up on X.',
      },
      allowed_x_handles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of X handles to include exclusively (max 10).',
      },
      excluded_x_handles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of X handles to exclude (max 10).',
      },
      from_date: {
        type: 'string',
        description: 'Optional start date in YYYY-MM-DD format.',
      },
      to_date: {
        type: 'string',
        description: 'Optional end date in YYYY-MM-DD format.',
      },
      enable_image_understanding: {
        type: 'boolean',
        description: 'Whether xAI should analyze images attached to matching X posts.',
        default: false,
      },
      enable_video_understanding: {
        type: 'boolean',
        description: 'Whether xAI should analyze videos attached to matching X posts.',
        default: false,
      },
      model: {
        type: 'string',
        description: 'Optional Grok model for the search request.',
      },
    },
    required: ['query'],
  }

  private credentialProvider?: XSearchCredentialProvider
  private fetchFn: typeof fetch
  private defaultBaseUrl: string
  private defaultModel: string
  private timeoutMs: number
  private maxRetries: number

  constructor(options: XSearchToolOptions = {}) {
    super()
    this.credentialProvider = options.credentialProvider
    this.fetchFn = options.fetchFn ?? fetch
    this.defaultBaseUrl = options.defaultBaseUrl ?? DEFAULT_XAI_BASE_URL
    this.defaultModel = options.defaultModel ?? DEFAULT_X_SEARCH_MODEL
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const parsed = input as XSearchInput
    const query = parsed.query?.trim()
    if (!query) {
      return {
        success: false,
        output: 'query is required for x_search',
        outputSummary: 'Missing query',
      }
    }

    const allowedHandles = normalizeHandles(parsed.allowed_x_handles, 'allowed_x_handles')
    const excludedHandles = normalizeHandles(parsed.excluded_x_handles, 'excluded_x_handles')
    if (allowedHandles.length > 0 && excludedHandles.length > 0) {
      return {
        success: false,
        output: 'allowed_x_handles and excluded_x_handles cannot be used together',
        outputSummary: 'Conflicting X handle filters',
      }
    }

    const credential = await this.resolveCredential(ctx)
    if (!credential) {
      return {
        success: false,
        output:
          'No xAI credentials available. Run `bun zero provider login x-premium` or set `xai_api_key` in the vault.',
        outputSummary: 'No xAI credentials',
      }
    }

    const toolDef: Record<string, unknown> = { type: 'x_search' }
    if (allowedHandles.length > 0) toolDef.allowed_x_handles = allowedHandles
    if (excludedHandles.length > 0) toolDef.excluded_x_handles = excludedHandles
    if (parsed.from_date?.trim()) toolDef.from_date = parsed.from_date.trim()
    if (parsed.to_date?.trim()) toolDef.to_date = parsed.to_date.trim()
    if (parsed.enable_image_understanding) toolDef.enable_image_understanding = true
    if (parsed.enable_video_understanding) toolDef.enable_video_understanding = true

    const model = parsed.model?.trim() || this.defaultModel
    const payload = {
      model,
      input: [{ role: 'user', content: query }],
      tools: [toolDef],
      store: false,
    }

    const response = await this.postWithRetries(credential, payload)
    if (!response.ok) {
      const error = await readErrorMessage(response)
      return {
        success: false,
        output: JSON.stringify(
          {
            success: false,
            provider: 'xai',
            tool: 'x_search',
            error,
            status: response.status,
          },
          null,
          2,
        ),
        outputSummary: `x_search failed: ${response.status} ${error}`.slice(0, 200),
      }
    }

    const data = (await response.json()) as Record<string, unknown>
    const answer = extractResponseText(data)
    const citations = Array.isArray(data.citations) ? data.citations : []
    const inlineCitations = extractInlineCitations(data)
    const output = JSON.stringify(
      {
        success: true,
        provider: 'xai',
        credential_source: credential.source ?? 'xai',
        tool: 'x_search',
        model,
        query,
        answer,
        citations,
        inline_citations: inlineCitations,
      },
      null,
      2,
    )

    return {
      success: true,
      output,
      outputSummary: summarizeXSearchResult(answer, citations.length + inlineCitations.length),
    }
  }

  private async resolveCredential(ctx: ToolContext): Promise<XSearchCredential | undefined> {
    if (this.credentialProvider) {
      return this.credentialProvider(ctx)
    }

    const apiKey = ctx.secretResolver?.('xai_api_key')?.trim()
    if (!apiKey) return undefined
    return {
      bearerToken: apiKey,
      authorizationScheme: 'Bearer',
      baseUrl: this.defaultBaseUrl,
      source: 'xai-api-key',
    }
  }

  private async postWithRetries(
    credential: XSearchCredential,
    payload: Record<string, unknown>,
  ): Promise<Response> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.post(credential, payload)
        if (response.status < 500 || attempt >= this.maxRetries) {
          return response
        }
      } catch (error) {
        lastError = error
        if (attempt >= this.maxRetries) {
          throw error
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error('x_search request failed')
  }

  private post(credential: XSearchCredential, payload: Record<string, unknown>): Promise<Response> {
    const baseUrl = (credential.baseUrl ?? this.defaultBaseUrl).replace(/\/+$/, '')
    const endpoint = baseUrl.endsWith('/v1') ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`
    const authorizationScheme = credential.authorizationScheme ?? 'Bearer'

    return this.fetchFn(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `${authorizationScheme} ${credential.bearerToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Zero-OS/x-search',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
  }
}

function normalizeHandles(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`)
  }

  const handles = value
    .map((item) =>
      String(item ?? '')
        .trim()
        .replace(/^@+/, ''),
    )
    .filter((item) => item.length > 0)
  if (handles.length > MAX_HANDLES) {
    throw new Error(`${fieldName} supports at most ${MAX_HANDLES} handles`)
  }
  return handles
}

function extractResponseText(payload: Record<string, unknown>): string {
  const outputText = typeof payload.output_text === 'string' ? payload.output_text.trim() : ''
  if (outputText) return outputText

  const parts: string[] = []
  const output = Array.isArray(payload.output) ? payload.output : []
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'message') continue
    const content = Array.isArray(item.content) ? item.content : []
    for (const part of content) {
      if (!isRecord(part)) continue
      if (part.type !== 'output_text' && part.type !== 'text') continue
      const text = typeof part.text === 'string' ? part.text.trim() : ''
      if (text) parts.push(text)
    }
  }
  return parts.join('\n\n')
}

function extractInlineCitations(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const citations: Array<Record<string, unknown>> = []
  const output = Array.isArray(payload.output) ? payload.output : []
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'message') continue
    const content = Array.isArray(item.content) ? item.content : []
    for (const part of content) {
      if (!isRecord(part)) continue
      const annotations = Array.isArray(part.annotations) ? part.annotations : []
      for (const annotation of annotations) {
        if (!isRecord(annotation) || annotation.type !== 'url_citation') continue
        citations.push({
          url: annotation.url ?? '',
          title: annotation.title ?? '',
          start_index: annotation.start_index,
          end_index: annotation.end_index,
        })
      }
    }
  }
  return citations
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text()
  if (!text.trim()) return response.statusText

  try {
    const payload = JSON.parse(text) as Record<string, unknown>
    const code = typeof payload.code === 'string' ? payload.code.trim() : ''
    const error =
      typeof payload.error === 'string'
        ? payload.error.trim()
        : typeof payload.message === 'string'
          ? payload.message.trim()
          : ''
    if (code && error && !error.includes(code)) return `${code}: ${error}`
    return error || code || text.slice(0, 500)
  } catch {
    return text.slice(0, 500)
  }
}

function summarizeXSearchResult(answer: string, citationCount: number): string {
  const trimmed = answer.trim()
  const prefix = trimmed ? trimmed.slice(0, 140) : 'x_search completed'
  return citationCount > 0 ? `${prefix} (${citationCount} citations)` : prefix
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
