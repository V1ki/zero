import { describe, expect, test } from 'bun:test'
import { createTelegramStreamFlusher, shouldFlushTelegramStreamText } from '../channels/telegram'

describe('telegram streaming flush controller', () => {
  test('forces a trailing flush after in-flight send completes', async () => {
    let text = 'chunk-1'
    const calls: string[] = []

    let releaseInitial: (() => void) | undefined
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })

    const flusher = createTelegramStreamFlusher({
      minIntervalMs: 350,
      now: () => 1_000,
      getText: () => text,
      sendInitial: async (payload) => {
        calls.push(`send:${payload}`)
        await initialGate
        return 9
      },
      edit: async (messageId, payload) => {
        calls.push(`edit:${messageId}:${payload}`)
      },
    })

    const firstFlush = flusher.flush(false)
    text = 'chunk-1-final'
    const forceFlush = flusher.flush(true)

    expect(calls).toEqual(['send:chunk-1'])

    releaseInitial?.()
    await Promise.all([firstFlush, forceFlush])

    expect(calls).toEqual(['send:chunk-1', 'edit:9:chunk-1-final'])
    expect(flusher.getLastFlushedText()).toBe('chunk-1-final')
  })

  test('keeps non-force cadence throttling', async () => {
    let nowMs = 1_000
    let text = 'hello'
    const calls: string[] = []

    const flusher = createTelegramStreamFlusher({
      minIntervalMs: 350,
      now: () => nowMs,
      getText: () => text,
      sendInitial: async (payload) => {
        calls.push(`send:${payload}`)
        return 7
      },
      edit: async (messageId, payload) => {
        calls.push(`edit:${messageId}:${payload}`)
      },
    })

    await flusher.flush(false)
    expect(calls).toEqual(['send:hello'])

    text = 'hello-2'
    nowMs = 1_100
    await flusher.flush(false)
    expect(calls).toEqual(['send:hello'])

    nowMs = 1_500
    await flusher.flush(false)
    expect(calls).toEqual(['send:hello', 'edit:7:hello-2'])
  })
})

describe('shouldFlushTelegramStreamText', () => {
  test('rejects empty, duplicate, and throttled non-forced flushes', () => {
    const base = {
      force: false,
      nowMs: 1_000,
      lastFlushAt: 900,
      minIntervalMs: 350,
      lastFlushedText: 'hello',
    }

    expect(shouldFlushTelegramStreamText({ ...base, text: '' })).toBe(false)
    expect(
      shouldFlushTelegramStreamText({
        ...base,
        text: 'hello-2',
      }),
    ).toBe(false)
    expect(
      shouldFlushTelegramStreamText({
        ...base,
        text: 'hello',
        nowMs: 1_500,
      }),
    ).toBe(false)
  })

  test('allows changed text after cadence and forced text immediately', () => {
    const base = {
      text: 'hello-2',
      nowMs: 1_500,
      lastFlushAt: 1_000,
      minIntervalMs: 350,
      lastFlushedText: 'hello',
    }

    expect(shouldFlushTelegramStreamText({ ...base, force: false })).toBe(true)
    expect(
      shouldFlushTelegramStreamText({
        ...base,
        text: 'hello',
        force: true,
        nowMs: 1_001,
      }),
    ).toBe(true)
  })
})
