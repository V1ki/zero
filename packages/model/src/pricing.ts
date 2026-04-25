import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelPricing } from '@zero-os/shared'

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

const CACHE_FILE = 'litellm_pricing.json'
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
const FETCH_TIMEOUT_MS = 15_000

/** Per-token entry from LiteLLM's JSON */
interface LiteLLMEntry {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
  [key: string]: unknown
}

/** Known provider prefixes used by LiteLLM */
const LITELLM_PREFIXES = [
  'anthropic/',
  'openai/',
  'google/',
  'azure/',
  'cohere/',
  'mistral/',
  'deepseek/',
] as const

/**
 * Convert LiteLLM per-token pricing to our per-million-token ModelPricing.
 */
export function convertPricing(entry: LiteLLMEntry): ModelPricing | null {
  const input = entry.input_cost_per_token
  const output = entry.output_cost_per_token
  if (input == null || output == null) return null

  const pricing: ModelPricing = {
    input: input * 1_000_000,
    output: output * 1_000_000,
  }

  if (entry.cache_creation_input_token_cost != null) {
    pricing.cacheWrite = entry.cache_creation_input_token_cost * 1_000_000
  }
  if (entry.cache_read_input_token_cost != null) {
    pricing.cacheRead = entry.cache_read_input_token_cost * 1_000_000
  }

  return pricing
}

/**
 * Find a matching entry in the LiteLLM data for a given model ID.
 *
 * Strategy (by priority):
 * 1. Exact match
 * 2. Add a known litellm provider prefix (anthropic/, openai/, etc.)
 * 3. Strip our own provider prefix and retry exact + prefixed
 */
export function findEntry(
  data: Record<string, LiteLLMEntry>,
  modelId: string,
): LiteLLMEntry | null {
  // 1. Exact match
  if (data[modelId]) return data[modelId]

  // 2. Try with litellm provider prefix
  for (const prefix of LITELLM_PREFIXES) {
    const key = `${prefix}${modelId}`
    if (data[key]) return data[key]
  }

  // 3. Strip our provider prefix (e.g. "my-provider/claude-opus-4-6" → "claude-opus-4-6")
  const slashIdx = modelId.indexOf('/')
  if (slashIdx > 0) {
    const bare = modelId.slice(slashIdx + 1)
    if (data[bare]) return data[bare]
    for (const prefix of LITELLM_PREFIXES) {
      const key = `${prefix}${bare}`
      if (data[key]) return data[key]
    }
  }

  return null
}

/**
 * LiteLLM Pricing — singleton that loads model pricing from LiteLLM's
 * public model_prices_and_context_window.json and provides synchronous
 * lookup by model ID.
 */
export class LiteLLMPricing {
  private static instance: LiteLLMPricing | null = null

  private cacheDir: string
  private data: Record<string, LiteLLMEntry> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null

  private constructor(cacheDir: string) {
    this.cacheDir = cacheDir
  }

  /** Initialize the singleton. Call once at startup. */
  static init(cacheDir: string): LiteLLMPricing {
    if (!LiteLLMPricing.instance) {
      LiteLLMPricing.instance = new LiteLLMPricing(cacheDir)
    }
    return LiteLLMPricing.instance
  }

  /** Get the singleton (or null if not initialized). */
  static getInstance(): LiteLLMPricing | null {
    return LiteLLMPricing.instance
  }

  /**
   * Load pricing data. Reads local cache first; fetches from GitHub if
   * cache is missing.
   */
  async ensureLoaded(): Promise<void> {
    if (this.data) return

    const cachePath = this.cachePath()

    // Try local cache first
    if (existsSync(cachePath)) {
      try {
        const raw = readFileSync(cachePath, 'utf-8')
        this.data = JSON.parse(raw)
        return
      } catch {
        // Corrupt cache — fall through to fetch
      }
    }

    // Fetch from GitHub
    await this.fetchAndCache()
  }

  /** Synchronous lookup. Returns null if data not loaded or model not found. */
  lookup(modelId: string): ModelPricing | null {
    if (!this.data) return null
    const entry = findEntry(this.data, modelId)
    if (!entry) return null
    return convertPricing(entry)
  }

  /** Start a 24h background refresh timer. */
  startRefresh(): void {
    if (this.refreshTimer) return
    this.refreshTimer = setInterval(() => {
      this.fetchAndCache().catch(() => {})
    }, REFRESH_INTERVAL_MS)

    // Don't block process exit
    if (
      this.refreshTimer &&
      typeof this.refreshTimer === 'object' &&
      'unref' in this.refreshTimer
    ) {
      this.refreshTimer.unref()
    }
  }

  /** Stop refresh timer and clear singleton. */
  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    LiteLLMPricing.instance = null
  }

  // ---- internal ----

  private cachePath(): string {
    return join(this.cacheDir, CACHE_FILE)
  }

  private async fetchAndCache(): Promise<void> {
    try {
      const response = await fetch(LITELLM_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) return
      const json = (await response.json()) as Record<string, LiteLLMEntry>
      this.data = json

      // Write cache
      if (!existsSync(this.cacheDir)) {
        mkdirSync(this.cacheDir, { recursive: true })
      }
      writeFileSync(this.cachePath(), JSON.stringify(json))
    } catch {
      // Network failure — keep existing data (if any) or stay null
    }
  }
}
