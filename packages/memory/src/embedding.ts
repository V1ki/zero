import type { Memory } from '@zero-os/shared'

export interface EmbeddingConfig {
  baseUrl: string
  apiKey: string
  model: string
  dimensions?: number
  onUsage?: (usage: {
    promptTokens: number
    totalTokens: number
    batchSize: number
    sessionId: string | null
  }) => void
}

export interface EmbeddingProvider {
  embed(text: string, sessionId?: string): Promise<number[]>
  embedBatch(texts: string[], sessionId?: string): Promise<number[][]>
  memoryToText(memory: Memory): string
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>
  usage?: { prompt_tokens?: number; total_tokens?: number }
}

export class EmbeddingClient implements EmbeddingProvider {
  constructor(private config: EmbeddingConfig) {}

  async embed(text: string, sessionId?: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text], sessionId)
    if (!vector) {
      throw new Error('Embedding service returned an empty result')
    }
    return vector
  }

  async embedBatch(texts: string[], sessionId?: string): Promise<number[][]> {
    if (texts.length === 0) return []

    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
        ...(this.config.dimensions ? { dimensions: this.config.dimensions } : {}),
      }),
    })

    if (!response.ok) {
      throw new Error(`Embedding request failed with status ${response.status}`)
    }

    const payload = (await response.json()) as EmbeddingResponse
    const vectors = payload.data
      ?.map((entry) => entry.embedding)
      .filter((entry): entry is number[] => Array.isArray(entry))
    if (!vectors || vectors.length !== texts.length) {
      throw new Error('Embedding service returned an unexpected payload')
    }

    if (payload.usage && this.config.onUsage) {
      this.config.onUsage({
        promptTokens: payload.usage.prompt_tokens ?? 0,
        totalTokens: payload.usage.total_tokens ?? 0,
        batchSize: texts.length,
        sessionId: sessionId ?? null,
      })
    }

    return vectors
  }

  memoryToText(memory: Memory): string {
    const tags = memory.tags.join(' ')
    const content = memory.content.replace(/\s+/g, ' ').trim().slice(0, 500)
    return [memory.title, tags, content].filter(Boolean).join('\n')
  }
}
