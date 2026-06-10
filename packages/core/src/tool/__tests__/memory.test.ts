import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryStore } from '@zero-os/memory'
import type { MemoryType, ToolContext } from '@zero-os/shared'
import { CONTEXT_PARAMS } from '../../agent/params'
import { createLiveDocHandle, deriveLiveDocKey } from '../../session/live-doc'
import { MemoryTool } from '../memory'

const testDir = join(import.meta.dir, '__fixtures__', 'memory-tool-test')

let store: MemoryStore

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

const makeCtx = (memoryStore?: MemoryStore) => ({
  sessionId: 'test_session',
  workDir: process.cwd(),
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  memoryStore,
})

// 用 Session 真实的活文档句柄工厂（createLiveDocHandle）测试 P3a 折叠，覆盖真实链路。
const makeLiveDocHandle = (s: MemoryStore) => createLiveDocHandle(new Map(), s)

beforeAll(() => {
  mkdirSync(testDir, { recursive: true })
  store = new MemoryStore(testDir)
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('MemoryTool', () => {
  const tool = new MemoryTool()

  test('creates a note memory', async () => {
    const result = await tool.run(makeCtx(store), {
      action: 'create',
      type: 'note',
      title: 'Test Note',
      content: 'This is a test note about TypeScript',
      tags: ['test', 'typescript'],
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Memory created')
    expect(result.output).toContain('Test Note')
  })

  test('creates a preference memory', async () => {
    const result = await tool.run(makeCtx(store), {
      action: 'create',
      type: 'preference',
      title: 'Language Preference',
      content: 'User prefers TypeScript over JavaScript',
      tags: ['language'],
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain('preference')
  })

  test('lists memories by type', async () => {
    const result = await tool.run(makeCtx(store), {
      action: 'list',
      type: 'note',
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Test Note')
  })

  test('lists empty type returns no memories message', async () => {
    const result = await tool.run(makeCtx(store), {
      action: 'list',
      type: 'incident',
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain('No memories of type')
  })

  test('updates a memory', async () => {
    // First create
    const createResult = await tool.run(makeCtx(store), {
      action: 'create',
      type: 'note',
      title: 'To Update',
      content: 'Original content',
    })
    const idMatch = createResult.output.match(/mem_[\w-]+/)
    expect(idMatch).not.toBeNull()

    // Then update
    const result = await tool.run(makeCtx(store), {
      action: 'update',
      type: 'note',
      id: expectDefined(idMatch)[0],
      updates: { content: 'Updated content', tags: ['updated'] },
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Memory updated')
  })

  test('updates a memory without type when id is enough', async () => {
    const createResult = await tool.run(makeCtx(store), {
      action: 'create',
      type: 'decision',
      title: 'Type Optional Update',
      content: 'Original content',
    })
    const idMatch = createResult.output.match(/mem_[\w-]+/)
    expect(idMatch).not.toBeNull()

    const result = await tool.run(makeCtx(store), {
      action: 'update',
      id: expectDefined(idMatch)[0],
      updates: { content: 'Updated without type' },
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Memory updated')
  })

  test('deletes a memory', async () => {
    // Create then delete
    const createResult = await tool.run(makeCtx(store), {
      action: 'create',
      type: 'note',
      title: 'To Delete',
      content: 'Will be deleted',
    })
    const idMatch = createResult.output.match(/mem_[\w-]+/)
    expect(idMatch).not.toBeNull()

    const result = await tool.run(makeCtx(store), {
      action: 'delete',
      type: 'note',
      id: expectDefined(idMatch)[0],
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Memory deleted')
  })

  test('deletes a memory without type when id is enough', async () => {
    const createResult = await tool.run(makeCtx(store), {
      action: 'create',
      type: 'incident',
      title: 'Delete Without Type',
      content: 'Will be deleted without type',
    })
    const idMatch = createResult.output.match(/mem_[\w-]+/)
    expect(idMatch).not.toBeNull()

    const result = await tool.run(makeCtx(store), {
      action: 'delete',
      id: expectDefined(idMatch)[0],
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Memory deleted')
  })

  test('fails without memoryStore in context', async () => {
    const result = await tool.run(makeCtx(), {
      action: 'list',
      type: 'note',
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('Memory store not available')
  })

  test('fails create without required fields', async () => {
    const result = await tool.run(makeCtx(store), {
      action: 'create',
      type: 'note',
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('requires type, title, and content')
  })

  test('fails update without id', async () => {
    const result = await tool.run(makeCtx(store), {
      action: 'update',
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('requires id')
  })

  test('fails delete without id', async () => {
    const result = await tool.run(makeCtx(store), {
      action: 'delete',
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('requires id')
  })

  test('fails delete with nonexistent id', async () => {
    const result = await tool.run(makeCtx(store), {
      action: 'delete',
      type: 'note',
      id: 'mem_nonexistent',
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('Memory not found')
  })

  test('update nonexistent memory returns not found', async () => {
    const result = await tool.run(makeCtx(store), {
      action: 'update',
      type: 'note',
      id: 'mem_nonexistent',
      updates: { title: 'New Title' },
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('Memory not found')
  })

  test('toDefinition returns correct schema', () => {
    const def = tool.toDefinition()
    expect(def.name).toBe('memory')
    expect(def.description).toContain('不用于 recall')
    expect(def.parameters.properties).toBeDefined()
    expect((def.parameters.properties as Record<string, unknown>).action).toBeDefined()
  })
})

describe('MemoryTool live-doc fold (P3a)', () => {
  const tool = new MemoryTool()

  test('same-topic create folds into update with bounded append', async () => {
    const ctx = { ...makeCtx(store), liveDocHandle: makeLiveDocHandle(store) }
    const r1 = await tool.run(ctx, {
      action: 'create',
      type: 'runbook',
      title: 'Deploy X',
      content: 'step one',
      tags: ['p3a-fold', 'deploy'],
    })
    expect(r1.success).toBe(true)
    expect(r1.output).toContain('Memory created')
    const id = expectDefined(r1.output.match(/mem_[\w-]+/))[0]

    const r2 = await tool.run(ctx, {
      action: 'create',
      type: 'runbook',
      title: 'Deploy X',
      content: 'step two',
      tags: ['p3a-fold', 'deploy'],
    })
    expect(r2.success).toBe(true)
    expect(r2.output).toContain('folded into live-doc')
    expect(r2.output).toContain(id)

    const merged = expectDefined(store.get('runbook', id))
    expect(merged.content).toContain('step one')
    expect(merged.content).toContain('step two')
  })

  test('different topic creates a separate memory', async () => {
    const ctx = { ...makeCtx(store), liveDocHandle: makeLiveDocHandle(store) }
    const r1 = await tool.run(ctx, {
      action: 'create',
      type: 'runbook',
      title: 'Topic A',
      content: 'a',
      tags: ['p3a-a'],
    })
    const r2 = await tool.run(ctx, {
      action: 'create',
      type: 'runbook',
      title: 'Topic B',
      content: 'b',
      tags: ['p3a-b'],
    })
    expect(r2.output).toContain('Memory created')
    expect(r2.output).not.toContain('folded')
    expect(expectDefined(r1.output.match(/mem_[\w-]+/))[0]).not.toBe(
      expectDefined(r2.output.match(/mem_[\w-]+/))[0],
    )
  })

  test('no liveDocHandle → always create (backward compatible)', async () => {
    const r1 = await tool.run(makeCtx(store), {
      action: 'create',
      type: 'note',
      title: 'No Handle',
      content: 'x',
      tags: ['p3a-nh'],
    })
    const r2 = await tool.run(makeCtx(store), {
      action: 'create',
      type: 'note',
      title: 'No Handle',
      content: 'y',
      tags: ['p3a-nh'],
    })
    expect(r1.output).toContain('Memory created')
    expect(r2.output).toContain('Memory created')
    expect(r2.output).not.toContain('folded')
  })

  test('vector fallback folds tag-drifted same-topic create (real handle)', async () => {
    let registeredId = ''
    // 包一层 memoryStore：findSimilar 模拟向量命中本会话已有活文档（真实 embedding 在集成环境验证）。
    const vecStore: ToolContext['memoryStore'] = {
      create: (t, ti, c, o) => store.create(t, ti, c, o),
      update: (t, i, u, c) => store.update(t, i, u, c),
      delete: (t, i) => store.delete(t, i),
      list: (t) => store.list(t),
      get: (t, i) => store.get(t, i),
      findSimilar: async (_input, opts) =>
        opts?.candidateIds?.includes(registeredId)
          ? { id: registeredId, type: 'runbook' as MemoryType, score: 0.95 }
          : undefined,
    }
    const ctx = {
      ...makeCtx(store),
      memoryStore: vecStore,
      liveDocHandle: createLiveDocHandle(new Map(), vecStore),
    }
    // CONTEXT_PARAMS 类型上 readonly；测试需要临时开向量 flag，用可写视图并在 finally 还原。
    const memoryParams = CONTEXT_PARAMS.memory as { liveDocVectorEnabled: boolean }
    const prev = memoryParams.liveDocVectorEnabled
    memoryParams.liveDocVectorEnabled = true
    try {
      const r1 = await tool.run(ctx, {
        action: 'create',
        type: 'runbook',
        title: 'Deploy Vec',
        content: 'phase one',
        tags: ['p3a-vec', 'deploy'],
      })
      registeredId = expectDefined(r1.output.match(/mem_[\w-]+/))[0]

      // tags 漂移（不撞 tag-key）→ 应由向量兜底折叠进同一条
      const r2 = await tool.run(ctx, {
        action: 'create',
        type: 'runbook',
        title: 'Deploy Vec continued',
        content: 'phase two',
        tags: ['p3a-vec', 'gpu'],
      })
      expect(r2.output).toContain('folded into live-doc')
      expect(r2.output).toContain(registeredId)
      const merged = expectDefined(store.get('runbook', registeredId))
      expect(merged.content).toContain('phase one')
      expect(merged.content).toContain('phase two')
    } finally {
      memoryParams.liveDocVectorEnabled = prev
    }
  })

  test('merge dedupes by exact section, not substring', async () => {
    const ctx = { ...makeCtx(store), liveDocHandle: makeLiveDocHandle(store) }
    const r1 = await tool.run(ctx, {
      action: 'create',
      type: 'note',
      title: 'Substr',
      content: 'step one with extended details',
      tags: ['p3a-substr'],
    })
    const id = expectDefined(r1.output.match(/mem_[\w-]+/))[0]
    // 旧实现 ex.includes(inc) 会把这条误吞；小节级全等判定应当 append。
    await tool.run(ctx, {
      action: 'create',
      type: 'note',
      title: 'Substr',
      content: 'step one',
      tags: ['p3a-substr'],
    })
    const afterAppend = expectDefined(store.get('note', id))
    expect(afterAppend.content).toContain('step one with extended details')
    expect(afterAppend.content.split('\n\n---\n\n').length).toBe(2)
    // 完全相同的小节再来一次 → 不重复追加。
    await tool.run(ctx, {
      action: 'create',
      type: 'note',
      title: 'Substr',
      content: 'step one',
      tags: ['p3a-substr'],
    })
    expect(expectDefined(store.get('note', id)).content.split('\n\n---\n\n').length).toBe(2)
  })

  test('single oversized section is hard-truncated to maxChars', async () => {
    const ctx = { ...makeCtx(store), liveDocHandle: makeLiveDocHandle(store) }
    const r1 = await tool.run(ctx, {
      action: 'create',
      type: 'note',
      title: 'Oversize',
      content: 'small head',
      tags: ['p3a-big'],
    })
    const id = expectDefined(r1.output.match(/mem_[\w-]+/))[0]
    await tool.run(ctx, {
      action: 'create',
      type: 'note',
      title: 'Oversize',
      content: 'x'.repeat(CONTEXT_PARAMS.memory.liveDocMaxChars + 1000),
      tags: ['p3a-big'],
    })
    const merged = expectDefined(store.get('note', id))
    expect(merged.content.length).toBeLessThanOrEqual(CONTEXT_PARAMS.memory.liveDocMaxChars)
  })

  test('whitespace-only tags fall back to title slug (no cross-topic collision)', () => {
    expect(deriveLiveDocKey('note', 'Topic Alpha', ['  '])).toBe('note|topic alpha')
    expect(deriveLiveDocKey('note', 'Topic Beta', [' '])).toBe('note|topic beta')
    expect(deriveLiveDocKey('note', 'Topic Alpha', ['  '])).not.toBe(
      deriveLiveDocKey('note', 'Topic Beta', [' ']),
    )
  })
})
