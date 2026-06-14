import { describe, expect, test } from 'bun:test'
import { RecentMessageTracker } from '../message-tracker'

describe('RecentMessageTracker', () => {
  test('allows first delivery and rejects duplicate message ids', () => {
    const tracker = new RecentMessageTracker()

    expect(tracker.shouldProcess('msg_1')).toBe(true)
    expect(tracker.shouldProcess('msg_1')).toBe(false)
    expect(tracker.shouldProcess('msg_2')).toBe(true)
  })

  test('does not track events without a message id', () => {
    const tracker = new RecentMessageTracker()

    expect(tracker.shouldProcess()).toBe(true)
    expect(tracker.shouldProcess('')).toBe(true)
    expect(tracker.shouldProcess()).toBe(true)
  })

  test('evicts oldest ids when capacity is exceeded', () => {
    const tracker = new RecentMessageTracker({ maxSize: 2 })

    expect(tracker.shouldProcess('oldest')).toBe(true)
    expect(tracker.shouldProcess('middle')).toBe(true)
    expect(tracker.shouldProcess('newest')).toBe(true)

    expect(tracker.shouldProcess('middle')).toBe(false)
    expect(tracker.shouldProcess('oldest')).toBe(true)
  })

  test('expires tracked ids after ttl', () => {
    let now = 1000
    const tracker = new RecentMessageTracker({ ttlMs: 1000, now: () => now })

    expect(tracker.shouldProcess('msg_1')).toBe(true)
    expect(tracker.shouldProcess('msg_1')).toBe(false)

    now = 2001

    expect(tracker.shouldProcess('msg_1')).toBe(true)
  })

  test('clear forgets all processed ids', () => {
    const tracker = new RecentMessageTracker()

    expect(tracker.shouldProcess('msg_1')).toBe(true)
    expect(tracker.shouldProcess('msg_1')).toBe(false)

    tracker.clear()

    expect(tracker.shouldProcess('msg_1')).toBe(true)
  })
})
