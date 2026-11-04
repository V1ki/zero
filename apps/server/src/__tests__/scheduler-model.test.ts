import { describe, expect, mock, test } from 'bun:test'
import type { Channel } from '@zero-os/channel'
import type { SessionManager } from '@zero-os/core'
import { handleScheduleTrigger } from '../runtime/scheduler'

describe('scheduler model routing', () => {
  test('a Router-only bot cannot be rebound by a schedule or receive its late reply', async () => {
    let owned = true
    const send = mock(async () => {})
    const bind = mock(() => ({
      isNew: false,
      session: {
        data: { id: 'old-session' },
        async handleMessage() {
          owned = true
          return [{ role: 'assistant', content: [{ type: 'text', text: 'old answer' }] }]
        },
      },
    }))
    const deps = {
      sessionManager: {
        isRouterOwnedChannel: () => owned,
        getOrCreateForChannel: bind,
      } as unknown as SessionManager,
      channels: new Map([['personal', { isConnected: () => true, send } as unknown as Channel]]),
      addNotification: () => {
        throw new Error('unexpected notification')
      },
    }
    const schedule = {
      name: 'previous',
      cron: '* * * * *',
      instruction: 'check',
      channel: { source: 'weixin' as const, channelName: 'personal', channelId: 'dm' },
    }
    await expect(handleScheduleTrigger(schedule, deps)).rejects.toThrow('Router-only')
    expect(bind).not.toHaveBeenCalled()
    owned = false
    await handleScheduleTrigger(schedule, deps)
    expect(bind).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  test('applies configured logical model routes before running the task', async () => {
    const calls: string[] = []
    const session = {
      data: { id: 'sess_schedule' },
      initAgent() {},
      async switchModel(model: string) {
        calls.push(`switch:${model}`)
        return { success: true, message: 'ok' }
      },
      async handleMessage(instruction: string) {
        calls.push(`run:${instruction}`)
        return []
      },
    }
    const sessionManager = {
      create() {
        return session
      },
    } as unknown as SessionManager

    await handleScheduleTrigger(
      {
        name: 'catalog-route-test',
        cron: '* * * * *',
        instruction: 'check models',
        model: 'route/coding-latest',
      },
      {
        sessionManager,
        channels: new Map(),
        addNotification: () => {
          throw new Error('notification should not be created')
        },
      },
    )

    expect(calls).toEqual(['switch:route/coding-latest', 'run:check models'])
  })

  test('does not run a schedule when its configured model cannot be resolved', async () => {
    let handled = false
    const session = {
      data: { id: 'sess_schedule' },
      initAgent() {},
      async switchModel() {
        return { success: false, message: 'Model not found' }
      },
      async handleMessage() {
        handled = true
        return []
      },
    }
    const sessionManager = {
      create() {
        return session
      },
    } as unknown as SessionManager

    await expect(
      handleScheduleTrigger(
        {
          name: 'bad-model',
          cron: '* * * * *',
          instruction: 'should not run',
          model: 'route/missing',
        },
        {
          sessionManager,
          channels: new Map(),
          addNotification: () => {
            throw new Error('notification should not be created')
          },
        },
      ),
    ).rejects.toThrow('model resolution failed')
    expect(handled).toBe(false)
  })
})
