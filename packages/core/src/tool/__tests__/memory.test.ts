import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryStore } from '@zero-os/memory'
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
