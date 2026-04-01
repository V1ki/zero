import { describe, expect, test } from 'bun:test'
import { DEFAULT_MODELS, parseArgs } from './runner'

describe('benchmark runner defaults', () => {
  test('uses chatgpt/gpt-5.4 as the default ChatGPT benchmark model', () => {
    expect(DEFAULT_MODELS).toEqual(['claude-opus-4-6', 'chatgpt/gpt-5.4'])
    expect(parseArgs([]).models).toEqual(DEFAULT_MODELS)
  })
})
