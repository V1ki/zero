import { describe, expect, test } from 'bun:test'
import {
  BACKGROUND_PROGRESS_STALE_MS,
  type BackgroundToolProgressEntry,
  backgroundProgressElapsedMs,
  backgroundProgressIsStale,
  createBackgroundProgressStore,
} from '../background-progress'

const SESSION = 'sess_progress_1'

function startedEvent(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    taskId: 'task_1',
    tool: 'bash',
    toolUseId: 'toolu_1',
    status: 'running',
    elapsedMs: 0,
    totalOutputChars: 0,
    lastOutputTail: '',
    ...overrides,
  }
}

describe('createBackgroundProgressStore', () => {
  test('lifecycle: started upserts, progress updates, completed drops the entry', () => {
    const store = createBackgroundProgressStore()
    expect(store.apply(SESSION, 'background_tool:started', startedEvent())).toBe(true)
    expect(store.get('toolu_1')).toMatchObject({ taskId: 'task_1', toolName: 'bash' })

    expect(
      store.apply(
        SESSION,
        'background_tool:progress',
        startedEvent({ elapsedMs: 15_000, totalOutputChars: 4200, lastOutputTail: 'tail' }),
      ),
    ).toBe(true)
    expect(store.get('toolu_1')).toMatchObject({
      elapsedMs: 15_000,
      totalOutputChars: 4200,
      lastOutputTail: 'tail',
    })

    expect(store.apply(SESSION, 'background_tool:completed', startedEvent())).toBe(true)
    expect(store.get('toolu_1')).toBeUndefined()
  })

  test('ignores events from other sessions', () => {
    const store = createBackgroundProgressStore()
    expect(store.apply('sess_other', 'background_tool:started', startedEvent())).toBe(false)
    expect(store.get('toolu_1')).toBeUndefined()
  })

  test('ignores malformed or non-matching events without crashing', () => {
    const store = createBackgroundProgressStore()
    expect(store.apply(SESSION, 'background_tool:started', null)).toBe(false)
    expect(store.apply(SESSION, 'background_tool:started', 'text')).toBe(false)
    expect(store.apply(SESSION, 'background_tool:started', {})).toBe(false)
    expect(store.apply(SESSION, 'unrelated:topic', startedEvent())).toBe(false)
    // missing taskId cannot anchor an entry
    expect(store.apply(SESSION, 'background_tool:progress', startedEvent({ taskId: 42 }))).toBe(
      false,
    )
    expect(store.get('toolu_1')).toBeUndefined()
  })

  test('keeps last valid values when a progress event omits fields', () => {
    const store = createBackgroundProgressStore()
    store.apply(SESSION, 'background_tool:started', startedEvent({ elapsedMs: 3_000 }))
    store.apply(
      SESSION,
      'background_tool:progress',
      startedEvent({ elapsedMs: 'x' as unknown as number, totalOutputChars: undefined }),
    )
    expect(store.get('toolu_1')?.elapsedMs).toBe(3_000)
    expect(store.get('toolu_1')?.totalOutputChars).toBe(0)
  })

  test('completed for an unknown toolUseId reports no change', () => {
    const store = createBackgroundProgressStore()
    expect(
      store.apply(SESSION, 'background_tool:completed', startedEvent({ toolUseId: 'toolu_x' })),
    ).toBe(false)
  })

  test('notifies subscribers on state change and on clear', () => {
    const store = createBackgroundProgressStore()
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })
    store.apply(SESSION, 'background_tool:started', startedEvent())
    store.apply(SESSION, 'background_tool:completed', startedEvent())
    store.clear()
    expect(notifications).toBe(2)
    // clear on an empty store does not notify
    store.clear()
    expect(notifications).toBe(2)
  })

  test('clear drops every entry', () => {
    const store = createBackgroundProgressStore()
    store.apply(SESSION, 'background_tool:started', startedEvent())
    store.apply(
      SESSION,
      'background_tool:started',
      startedEvent({ toolUseId: 'toolu_2', taskId: 'task_2' }),
    )
    store.clear()
    expect(store.get('toolu_1')).toBeUndefined()
    expect(store.get('toolu_2')).toBeUndefined()
  })
})

describe('backgroundProgressIsStale', () => {
  const entry: BackgroundToolProgressEntry = {
    taskId: 'task_1',
    toolName: 'bash',
    elapsedMs: 1_000,
    totalOutputChars: 10,
    lastOutputTail: 'x',
    lastSeenAt: 100_000,
  }

  test('fresh within the heartbeat trust window', () => {
    expect(backgroundProgressIsStale(entry, 100_000 + BACKGROUND_PROGRESS_STALE_MS)).toBe(false)
  })

  test('stale once events stopped arriving past the window', () => {
    expect(backgroundProgressIsStale(entry, 100_000 + BACKGROUND_PROGRESS_STALE_MS + 1)).toBe(true)
  })
})

describe('backgroundProgressElapsedMs', () => {
  test('adds client drift since the last event to the reported elapsed', () => {
    const entry: BackgroundToolProgressEntry = {
      taskId: 'task_1',
      toolName: 'bash',
      elapsedMs: 15_000,
      totalOutputChars: 10,
      lastOutputTail: 'x',
      lastSeenAt: 100_000,
    }
    expect(backgroundProgressElapsedMs(entry, 100_000 + 5_000)).toBe(20_000)
  })

  test('never runs backwards when now precedes the last event', () => {
    const entry: BackgroundToolProgressEntry = {
      taskId: 'task_1',
      toolName: 'bash',
      elapsedMs: 15_000,
      totalOutputChars: 10,
      lastOutputTail: 'x',
      lastSeenAt: 100_000,
    }
    expect(backgroundProgressElapsedMs(entry, 99_000)).toBe(15_000)
  })
})
