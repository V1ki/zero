import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type EmbeddingProvider,
  IndexedMemoryStore,
  MemoryRetriever,
  MemoryStore,
  VectorIndex,
} from '@zero-os/memory'
import { MemoryReadTool, MemorySearchTool } from '../memory'

let testDir = ''

let store: IndexedMemoryStore
let retriever: MemoryRetriever
let preferenceId = ''

function createEmbeddingProvider(): EmbeddingProvider {
  const embedText = (text: string): number[] => {
    const normalized = text.toLowerCase()
    return [
      Number(normalized.includes('deploy')) + Number(normalized.includes('release')),
      Number(normalized.includes('typescript')) + Number(normalized.includes('language')),
    ]
  }

  return {
    async embed(text: string): Promise<number[]> {
      return embedText(text)
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map((text) => embedText(text))
    },
    memoryToText(memory) {
      return [memory.title, memory.tags.join(' '), memory.content].join('\n')
    },
  }
}

const makeCtx = () => ({
  sessionId: 'test_session',
  workDir: process.cwd(),
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  memoryStore: store,
  memoryRetriever: retriever,
})

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'zero-memory-recall-'))
  mkdirSync(join(testDir, 'notes'), { recursive: true })
  const baseStore = new MemoryStore(testDir)
  const embeddingClient = createEmbeddingProvider()
  const vectorIndex = new VectorIndex(join(testDir, 'vectors'))
  store = new IndexedMemoryStore(baseStore, embeddingClient, vectorIndex)
  retriever = new MemoryRetriever(store, embeddingClient, vectorIndex, {
    vectorWeight: 0.8,
    recencyWeight: 0.2,
  })

  await store.create('note', 'Deploy Checklist', 'Run bun run check before release', {
    status: 'verified',
    confidence: 0.92,
    tags: ['deploy', 'release'],
  })
  const preference = await store.create(
    'preference',
    'Language Preference',
    'User prefers TypeScript over JavaScript',
    {
      status: 'verified',
      confidence: 0.95,
      tags: ['preference', 'typescript'],
    },
  )
  preferenceId = preference.id

  writeFileSync(join(testDir, 'notes', 'manual.md'), 'line1\nline2\nline3\nline4\n', 'utf-8')
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('Memory recall tools', () => {
  test('memory_search returns preference memories with path and score', async () => {
    const tool = new MemorySearchTool()
    const result = await tool.run(makeCtx(), {
      query: 'language preference typescript',
      maxResults: 5,
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('Language Preference')
    expect(result.output).toContain(`.zero/memory/preferences/${preferenceId}.md`)
    expect(result.output).toContain('score:')
    expect(result.output).toContain('keyword:')
    expect(result.output).toContain('recency:')
    expect(result.output).toContain('age:')
    expect(result.output).toContain('User prefers TypeScript')
  })

  test('memory_search returns no-match message when nothing is found', async () => {
    const tool = new MemorySearchTool()
    const result = await tool.run(
      {
        ...makeCtx(),
        memoryRetriever: {
          async retrieve() {
            return []
          },
          async retrieveScored() {
            return []
          },
        },
      },
      {
        query: 'completely unrelated search terms',
      },
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('No relevant memories found')
  })

  test('memory_search forwards sessionId into retriever options', async () => {
    const tool = new MemorySearchTool()
    const result = await tool.run(
      {
        ...makeCtx(),
        memoryRetriever: {
          async retrieve() {
            return []
          },
          async retrieveScored(_query, options) {
            expect(options?.sessionId).toBe('test_session')
            return []
          },
        },
      },
      {
        query: 'deploy preference',
      },
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('No relevant memories found')
  })

  test('memory_read reads a full memory file by path', async () => {
    const tool = new MemoryReadTool()
    const result = await tool.run(makeCtx(), {
      path: '.zero/memory/notes/manual.md',
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('Path: .zero/memory/notes/manual.md')
    expect(result.output).toContain('line1')
    expect(result.output).toContain('line4')
  })

  test('memory_read supports line windows', async () => {
    const tool = new MemoryReadTool()
    const result = await tool.run(makeCtx(), {
      path: '.zero/memory/notes/manual.md',
      from: 2,
      lines: 2,
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('Range: from=2 lines=2')
    expect(result.output).toContain('line2\nline3')
    expect(result.output).not.toContain('line1')
  })

  test('memory_read returns empty content for missing files', async () => {
    const tool = new MemoryReadTool()
    const result = await tool.run(makeCtx(), {
      path: '.zero/memory/notes/missing.md',
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('Path: .zero/memory/notes/missing.md')
    expect(result.outputSummary).toContain('empty or missing')
  })

  test('memory_read rejects memo path', async () => {
    const tool = new MemoryReadTool()
    const result = await tool.run(makeCtx(), {
      path: '.zero/memory/memo.md',
    })

    expect(result.success).toBe(false)
    expect(result.output).toContain('Invalid memory path')
  })

  test('memory_read rejects traversal paths', async () => {
    const tool = new MemoryReadTool()
    const result = await tool.run(makeCtx(), {
      path: '.zero/memory/../secrets.enc',
    })

    expect(result.success).toBe(false)
    expect(result.output).toContain('Invalid memory path')
  })
})
