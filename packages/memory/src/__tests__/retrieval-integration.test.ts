import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EmbeddingProvider } from '../embedding'
import { IndexedMemoryStore } from '../indexed-store'
import { MemoryLifecycle } from '../lifecycle'
import { MemoryRetriever } from '../retrieval'
import { MemoryStore } from '../store'
import { VectorIndex } from '../vector-index'

function createEmbeddingProvider(): EmbeddingProvider {
  const embedText = (text: string): number[] => {
    const normalized = text.toLowerCase()
    const deployScore =
      Number(normalized.includes('deploy')) +
      Number(normalized.includes('gateway')) +
      Number(normalized.includes('api'))
    const databaseScore =
      Number(normalized.includes('database')) +
      Number(normalized.includes('timeout')) +
      Number(normalized.includes('incident'))
    const preferenceScore =
      Number(normalized.includes('typescript')) +
      Number(normalized.includes('preference')) +
      Number(normalized.includes('language'))

    return [deployScore, databaseScore, preferenceScore]
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

async function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-retrieval-int-'))
  const store = new MemoryStore(dir)
  const vectorIndex = new VectorIndex(join(dir, 'vectors'))
  const embeddingClient = createEmbeddingProvider()
  const indexedStore = new IndexedMemoryStore(store, embeddingClient, vectorIndex)
  const lifecycle = new MemoryLifecycle(indexedStore)
  const retriever = new MemoryRetriever(indexedStore, embeddingClient, vectorIndex, {
    recencyHalfLifeDays: 30,
  })

  return {
    dir,
    store: indexedStore,
    lifecycle,
    retriever,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('Memory Pipeline: Indexed store -> Vector index -> Retrieval', () => {
  test('retrieves verified incidents through the real vector index', async () => {
    const harness = await createHarness()

    try {
      const incident = await harness.lifecycle.createIncident(
        'Database timeout',
        'Connection pool exhausted',
        'sess-002',
        ['database', 'timeout'],
      )
      await harness.lifecycle.verify('incident', incident.id)

      const results = await harness.retriever.retrieve('database timeout', { topN: 5 })

      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.title).toBe('Database timeout')
    } finally {
      harness.cleanup()
    }
  })

  test('default retrieval excludes session memories, but explicit session search still works', async () => {
    const harness = await createHarness()

    try {
      const sessionMemory = await harness.lifecycle.createSessionMemory(
        'sess-001',
        'Deployed API gateway successfully',
        ['deploy', 'api'],
      )

      await expect(harness.retriever.retrieve('deploy api gateway')).resolves.toEqual([])

      const sessionResults = await harness.retriever.retrieve('deploy api gateway', {
        topN: 5,
        types: ['session'],
      })

      expect(sessionResults).toHaveLength(1)
      expect(sessionResults[0]?.id).toBe(sessionMemory.id)
    } finally {
      harness.cleanup()
    }
  })

  test('archived memories stay excluded even when their vectors remain indexed', async () => {
    const harness = await createHarness()

    try {
      const memory = await harness.store.create('note', 'Old deploy note', 'deploy gateway history', {
        tags: ['deploy'],
        status: 'verified',
        confidence: 0.9,
      })
      await harness.store.update('note', memory.id, { status: 'archived' })

      const results = await harness.retriever.retrieve('deploy gateway', { confidenceThreshold: 0.1 })

      expect(results).toEqual([])
    } finally {
      harness.cleanup()
    }
  })

  test('conflict resolution keeps only the winning verified note in retrieval results', async () => {
    const harness = await createHarness()

    try {
      const winner = await harness.store.create('note', 'Deploy decision winner', 'deploy gateway plan', {
        tags: ['deploy'],
        status: 'verified',
        confidence: 0.9,
      })
      const loser = await harness.store.create('note', 'Deploy decision loser', 'deploy gateway plan', {
        tags: ['deploy'],
        status: 'verified',
        confidence: 0.6,
      })

      await harness.lifecycle.resolveConflict('note', winner.id, loser.id)

      const results = await harness.retriever.retrieve('deploy gateway', {
        topN: 5,
        tags: ['deploy'],
      })

      const ids = results.map((memory) => memory.id)
      expect(ids).toContain(winner.id)
      expect(ids).not.toContain(loser.id)
    } finally {
      harness.cleanup()
    }
  })

  test('minScore trims weak vector matches in the integrated stack', async () => {
    const harness = await createHarness()

    try {
      await harness.store.create('note', 'Deploy Checklist', 'deploy gateway checklist', {
        tags: ['deploy'],
        status: 'verified',
        confidence: 0.95,
      })
      await harness.store.create('note', 'TypeScript preference', 'language preference typescript', {
        tags: ['preference', 'typescript'],
        status: 'verified',
        confidence: 0.95,
      })

      const results = await harness.retriever.retrieveScored('deploy gateway', {
        topN: 5,
        minScore: 0.6,
      })

      expect(results).toHaveLength(1)
      expect(results[0]?.memory.title).toBe('Deploy Checklist')
    } finally {
      harness.cleanup()
    }
  })
})
