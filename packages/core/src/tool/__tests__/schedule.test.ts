import { describe, expect, test } from 'bun:test'
import type { ScheduleConfig, ToolContext } from '@zero-os/shared'
import { ScheduleTool } from '../schedule'

function createMockContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const schedules = new Map<string, ScheduleConfig>()
  const statuses: Array<{ name: string; nextRun: Date; running: boolean; lastRun?: Date }> = []

  return {
    sessionId: 'test-session',
    workDir: '/tmp/test',
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    channelBinding: {
      source: 'feishu',
      channelName: 'feishu',
      channelId: 'oc_abc123',
    },
    schedulerHandle: {
      addAndStart(config: ScheduleConfig) {
        schedules.set(config.name, config)
        statuses.push({
          name: config.name,
          nextRun: new Date(Date.now() + 3600000),
          running: false,
        })
      },
      remove(name: string) {
        const had = schedules.has(name)
        schedules.delete(name)
        const idx = statuses.findIndex((s) => s.name === name)
        if (idx >= 0) statuses.splice(idx, 1)
        return had
      },
      getStatus() {
        return [...statuses]
      },
    },
    scheduleStore: {
      save(config: ScheduleConfig) {
        schedules.set(config.name, config)
      },
      delete(name: string) {
        return schedules.delete(name)
      },
    },
    ...overrides,
  } as ToolContext
}

describe('ScheduleTool', () => {
  const tool = new ScheduleTool()

  test('tool definition tells the model to ground relative time against current local time', () => {
    const definition = tool.toDefinition()
    const parameters = definition.parameters as {
      properties?: Record<string, { description?: string }>
    }

    expect(definition.description).toContain('first obtain the current local time')
    expect(definition.description).toContain('verify that the returned cron')
    expect(String(parameters.properties?.cron?.description)).toContain(
      'first check the current local time',
    )
  })

  test('create: adds schedule with channel binding', async () => {
    const ctx = createMockContext()
    const result = await tool.run(ctx, {
      action: 'create',
      name: 'my-reminder',
      cron: '0 9 * * *',
      instruction: 'Check the build',
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('my-reminder')
    expect(result.output).toContain('feishu:oc_abc123')
  })

  test('create: preserves participant and real delivery channel binding', async () => {
    let saved: ScheduleConfig | undefined
    const ctx = createMockContext({
      channelBinding: {
        source: 'feishu',
        channelName: 'feishu',
        channelId: 'oc_group',
        participantId: 'ou_alice',
        deliveryChannelId: 'oc_group',
      },
      scheduleStore: {
        save(config) {
          saved = config
        },
        delete: () => false,
      },
    })

    const result = await tool.run(ctx, {
      action: 'create',
      name: 'participant-reminder',
      cron: '0 9 * * *',
      instruction: 'Check the build',
    })

    expect(result.success).toBe(true)
    expect(saved?.channel).toEqual({
      source: 'feishu',
      channelName: 'feishu',
      channelId: 'oc_group',
      participantId: 'ou_alice',
      deliveryChannelId: 'oc_group',
    })
  })

  test('create: auto-generates name if not provided', async () => {
    const ctx = createMockContext()
    const result = await tool.run(ctx, {
      action: 'create',
      cron: '*/5 * * * *',
      instruction: 'do stuff',
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('sched-')
  })

  test('create: oneShot flag preserved', async () => {
    const ctx = createMockContext()
    const result = await tool.run(ctx, {
      action: 'create',
      name: 'one-shot-job',
      cron: '0 0 * * *',
      instruction: 'fire once',
      oneShot: true,
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('One-shot: yes')
  })

  test('create: fails without cron', async () => {
    const ctx = createMockContext()
    const result = await tool.run(ctx, {
      action: 'create',
      name: 'bad',
      instruction: 'no cron',
    })

    expect(result.success).toBe(false)
    expect(result.output).toContain('cron')
  })

  test('create: fails without instruction', async () => {
    const ctx = createMockContext()
    const result = await tool.run(ctx, {
      action: 'create',
      name: 'bad',
      cron: '0 0 * * *',
    })

    expect(result.success).toBe(false)
    expect(result.output).toContain('instruction')
  })

  test('create: works without channel binding', async () => {
    const ctx = createMockContext({ channelBinding: undefined })
    const result = await tool.run(ctx, {
      action: 'create',
      name: 'no-channel',
      cron: '0 0 * * *',
      instruction: 'test',
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('no channel binding')
  })

  test('list: shows schedules', async () => {
    const ctx = createMockContext()
    // Create two schedules first
    await tool.run(ctx, { action: 'create', name: 'job-a', cron: '0 1 * * *', instruction: 'a' })
    await tool.run(ctx, { action: 'create', name: 'job-b', cron: '0 2 * * *', instruction: 'b' })

    const result = await tool.run(ctx, { action: 'list' })

    expect(result.success).toBe(true)
    expect(result.output).toContain('job-a')
    expect(result.output).toContain('job-b')
    expect(result.output).toContain('Active schedules (2)')
  })

  test('list: empty state', async () => {
    const ctx = createMockContext()
    const result = await tool.run(ctx, { action: 'list' })

    expect(result.success).toBe(true)
    expect(result.output).toContain('No active schedules')
  })

  test('cancel: removes existing schedule', async () => {
    const ctx = createMockContext()
    await tool.run(ctx, {
      action: 'create',
      name: 'to-cancel',
      cron: '0 0 * * *',
      instruction: 'x',
    })

    const result = await tool.run(ctx, { action: 'cancel', name: 'to-cancel' })

    expect(result.success).toBe(true)
    expect(result.output).toContain('cancelled')
  })

  test('cancel: fails for non-existent schedule', async () => {
    const ctx = createMockContext()
    const result = await tool.run(ctx, { action: 'cancel', name: 'nope' })

    expect(result.success).toBe(false)
    expect(result.output).toContain('not found')
  })

  test('cancel: fails without name', async () => {
    const ctx = createMockContext()
    const result = await tool.run(ctx, { action: 'cancel' })

    expect(result.success).toBe(false)
    expect(result.output).toContain('name')
  })

  test('fails when scheduler not available', async () => {
    const ctx = createMockContext({ schedulerHandle: undefined })
    const result = await tool.run(ctx, { action: 'list' })

    expect(result.success).toBe(false)
    expect(result.output).toContain('not available')
  })
})
