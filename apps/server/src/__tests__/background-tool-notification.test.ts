import { describe, expect, test } from 'bun:test'
import type { BusPayload } from '../runtime/bus'
import {
  buildBackgroundToolNotificationText,
  shouldPrefixBackgroundToolSessionId,
} from '../runtime/startup'

function payload(data: Record<string, unknown>): BusPayload {
  return {
    topic: 'background_tool:completed',
    data,
    timestamp: '2026-07-04T00:00:00.000Z',
  }
}

describe('buildBackgroundToolNotificationText', () => {
  test('omits the owning session id for the current session notification', () => {
    const text = buildBackgroundToolNotificationText(
      payload({
        sessionId: 'sess_20260703_1926_fei_c887',
        tool: 'codex',
        status: 'success',
        outputSummary: '18 file(s) changed, 132 command(s) run',
      }),
    )

    expect(text).toBe('Background codex task completed: 18 file(s) changed, 132 command(s) run')
  })

  test('prefixes cross-session background notifications with the owning session id', () => {
    const text = buildBackgroundToolNotificationText(
      payload({
        sessionId: 'sess_20260703_1926_fei_c887',
        tool: 'codex',
        status: 'success',
        outputSummary: '18 file(s) changed, 132 command(s) run',
      }),
      { prefixSessionId: true },
    )

    expect(text).toBe(
      'sess_20260703_1926_fei_c887: Background codex task completed: 18 file(s) changed, 132 command(s) run',
    )
  })

  test('keeps the legacy message shape when no session id is available', () => {
    const text = buildBackgroundToolNotificationText(
      payload({
        tool: 'bash',
        status: 'error',
      }),
    )

    expect(text).toBe('Background bash task failed.')
  })
})

describe('shouldPrefixBackgroundToolSessionId', () => {
  const backgroundPayload = payload({
    sessionId: 'sess_A',
    source: 'feishu',
    channelName: 'nanoclaw',
    channelId: 'oc_feishu',
    deliveryChannelId: 'oc_feishu',
    participantId: 'ou_user',
  })

  test('does not prefix when the background owner is still the current channel session', () => {
    const sessionManager = {
      isCurrentSessionForChannel: () => true,
    }

    expect(shouldPrefixBackgroundToolSessionId(backgroundPayload, sessionManager)).toBe(false)
  })

  test('prefixes when the channel has moved to a different session', () => {
    const calls: unknown[][] = []
    const sessionManager = {
      isCurrentSessionForChannel: (...args: unknown[]) => {
        calls.push(args)
        return false
      },
    }

    expect(shouldPrefixBackgroundToolSessionId(backgroundPayload, sessionManager)).toBe(true)
    expect(calls[0]).toEqual(['feishu', 'oc_feishu', 'nanoclaw', 'sess_A', 'ou_user'])
  })

  test('does not prefix when channel identity is unavailable', () => {
    const sessionManager = {
      isCurrentSessionForChannel: () => false,
    }

    expect(
      shouldPrefixBackgroundToolSessionId(
        payload({
          sessionId: 'sess_A',
          tool: 'codex',
        }),
        sessionManager,
      ),
    ).toBe(false)
  })
})
