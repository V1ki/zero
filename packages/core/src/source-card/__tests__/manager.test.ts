import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceCard } from '@zero-os/shared'
import { SourceCardManager } from '../index'

const tempDirs: string[] = []

function createManager(options?: ConstructorParameters<typeof SourceCardManager>[1]) {
  const dir = mkdtempSync(join(tmpdir(), 'zero-source-card-'))
  tempDirs.push(dir)
  return new SourceCardManager(dir, options)
}

function createCard(overrides: Partial<SourceCard> = {}): SourceCard {
  return {
    schemaVersion: 1,
    id: 'market-doc',
    title: 'Market data doc',
    state: 'draft',
    sensitivity: 'public',
    tags: ['market-data'],
    sourceDoc: {
      format: 'markdown',
      body: '# Market data doc\n\n## When to use\n- Use for public stock quotes.\n\n## How to use\n- Fetch https://example.invalid/quote.',
    },
    source: {
      sessionId: 'sess_20260512_0000_web_doc',
      summary: 'Mined from a public market-data session.',
    },
    ...overrides,
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('SourceCardManager', () => {
  test('creates, stamps, gets, and lists Markdown Source Cards', () => {
    const manager = createManager()

    const created = manager.create(createCard())

    expect(typeof created.createdAt).toBe('string')
    expect(typeof created.updatedAt).toBe('string')
    expect(manager.get('market-doc')?.sourceDoc.body).toContain('https://example.invalid/quote')
    expect(manager.list().map((card) => card.id)).toEqual(['market-doc'])
  })

  test('updates documents without allowing id changes', () => {
    const manager = createManager()
    manager.create(createCard())

    const updated = manager.update('market-doc', (card) => ({
      ...card,
      title: 'Updated market data doc',
      sourceDoc: {
        ...card.sourceDoc,
        body: `${card.sourceDoc.body}\n- Prefer the documented fallback URL.`,
      },
    }))

    expect(updated.title).toBe('Updated market data doc')
    expect(updated.sourceDoc.body).toContain('fallback URL')
    expect(() =>
      manager.update('market-doc', (card) => ({
        ...card,
        id: 'changed-id',
      })),
    ).toThrow('cannot change id')
  })

  test('enforces simplified lifecycle transition boundaries', () => {
    const manager = createManager()
    manager.create(createCard())

    expect(manager.transitionState('market-doc', 'active', 'manual review passed').state).toBe(
      'active',
    )
    expect(manager.transitionState('market-doc', 'retired', 'source no longer used').state).toBe(
      'retired',
    )
    expect(() => manager.transitionState('market-doc', 'active', 'cannot restore')).toThrow(
      'Invalid SourceCard state transition',
    )
  })

  test('rejects unsafe ids before touching source card paths', () => {
    const manager = createManager()
    manager.create(createCard())

    expect(() => manager.get('../market-doc')).toThrow('sourceCardId must be')
    expect(() => manager.delete('../market-doc')).toThrow('sourceCardId must be')
  })

  test('redacts audit data and can delete cards', () => {
    const audit: unknown[] = []
    const manager = createManager({
      audit: (entry) => audit.push(entry),
    })
    manager.create(createCard())
    manager.transitionState('market-doc', 'active', 'authorization: Bearer secret-token')

    expect(manager.delete('market-doc')).toBe(true)
    expect(manager.get('market-doc')).toBeUndefined()
    expect(JSON.stringify(audit)).not.toContain('secret-token')
    expect(JSON.stringify(audit)).toContain('[REDACTED]')
  })
})
