import { describe, expect, test } from 'bun:test'
import type { CompletionRequest, CompletionResponse, StreamEvent } from '@zero-os/shared'
import type { ProviderAdapter } from '../adapters/base'
import {
  ModelPolicyAdapter,
  classifyRuntimeModelError,
  negotiateReasoningEffort,
} from '../adapters/model-policy'

describe('model request policy', () => {
  test('clamps unsupported reasoning effort to the nearest supported level', () => {
    expect(negotiateReasoningEffort('xhigh', ['low', 'high'])).toBe('high')
    expect(negotiateReasoningEffort('medium', ['low', 'high'])).toBe('low')
    expect(negotiateReasoningEffort('high', ['low', 'high'])).toBe('high')
  })

  test('preserves legacy behavior when supported levels are unknown', () => {
    expect(negotiateReasoningEffort('xhigh', undefined)).toBe('xhigh')
    expect(negotiateReasoningEffort(undefined, ['low'])).toBeUndefined()
  })

  test('classifies only model compatibility errors', () => {
    expect(classifyRuntimeModelError(new Error('Model not found gpt-5.6-luna'))).toBe(
      'model_not_found',
    )
    expect(
      classifyRuntimeModelError(
        new Error("The model 'gpt-5.6-luna' does not exist or you do not have access to it"),
      ),
    ).toBe('model_not_found')
    expect(classifyRuntimeModelError({ code: 'model_not_found' })).toBe('model_not_found')
    expect(
      classifyRuntimeModelError(
        new Error("The 'gpt-5-6-pro' model is not supported when using Codex"),
      ),
    ).toBe('unsupported_model')
    expect(classifyRuntimeModelError(new Error('HTTP 404 Not Found'))).toBeUndefined()
  })

  test('normalizes reasoning and emits runtime model invalidation events', async () => {
    let captured: CompletionRequest | undefined
    const events: string[] = []
    const inner: ProviderAdapter = {
      apiType: 'fake',
      async complete(req): Promise<CompletionResponse> {
        captured = req
        throw new Error('Model not found gpt-5.6-luna')
      },
      async *stream(): AsyncIterable<StreamEvent> {},
      async healthCheck() {
        return true
      },
    }
    const adapter = new ModelPolicyAdapter(
      inner,
      'chatgpt',
      'gpt-5.6-luna',
      {
        modelId: 'gpt-5.6-luna',
        maxContext: 372000,
        maxOutput: 8192,
        reasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium'],
        capabilities: ['reasoning'],
        tags: [],
      },
      (event) => {
        events.push(`${event.providerName}/${event.modelName}:${event.reason}`)
      },
    )

    await expect(
      adapter.complete({ messages: [], stream: false, reasoningEffort: 'xhigh' }),
    ).rejects.toThrow('Model not found')
    await Promise.resolve()

    expect(captured?.reasoningEffort).toBe('medium')
    expect(events).toEqual(['chatgpt/gpt-5.6-luna:model_not_found'])
  })
})
