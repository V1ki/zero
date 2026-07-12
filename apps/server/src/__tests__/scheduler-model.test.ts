import { describe, expect, test } from 'bun:test'
import type { SessionManager } from '@zero-os/core'
import { handleScheduleTrigger } from '../runtime/scheduler'

describe('scheduler model routing', () => {
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
