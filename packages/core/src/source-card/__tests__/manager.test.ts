import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SourceCardManager,
  createAStockMarketDataSourceCard,
  createQqMailHimalayaSourceCard,
} from '../index'

const tempDirs: string[] = []

function createManager(): SourceCardManager {
  const dir = mkdtempSync(join(tmpdir(), 'zero-source-card-'))
  tempDirs.push(dir)
  return new SourceCardManager(dir)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('SourceCardManager', () => {
  test('creates and lists sample Source Cards', () => {
    const manager = createManager()

    manager.create(createQqMailHimalayaSourceCard())
    manager.create(createAStockMarketDataSourceCard())

    expect(manager.get('qq-mail-himalaya')?.state).toBe('candidate')
    expect(manager.get('a-stock-market-data')?.state).toBe('active')
    expect(manager.list().map((card) => card.id)).toEqual([
      'a-stock-market-data',
      'qq-mail-himalaya',
    ])
  })

  test('enforces lifecycle transition boundaries', () => {
    const manager = createManager()
    manager.create(createQqMailHimalayaSourceCard())

    expect(manager.transitionState('qq-mail-himalaya', 'verified', 'metadata verified').state).toBe(
      'verified',
    )
    expect(() =>
      manager.transitionState('qq-mail-himalaya', 'discovered', 'cannot go backwards'),
    ).toThrow('Invalid SourceCard state transition')
  })

  test('records observations without mutating the Source Card', () => {
    const manager = createManager()
    const card = manager.create(createAStockMarketDataSourceCard())

    const observation = manager.recordObservation({
      sourceCardId: card.id,
      capabilityId: 'fetch_quotes',
      kind: 'data',
      data: {
        symbols: ['SH000001'],
        rows: 1,
      },
    })

    expect(observation.id?.startsWith('obs_')).toBe(true)
    expect(manager.listObservations(card.id)).toHaveLength(1)
    expect(manager.get(card.id)?.updatedAt).toBe(card.updatedAt)
  })

  test('records health checks as redacted evidence and degrades unhealthy cards', () => {
    const manager = createManager()
    const card = manager.create(createAStockMarketDataSourceCard())

    const updated = manager.recordHealthResult(card.id, {
      checkId: 'eastmoney_quote_health',
      status: 'failed',
      checkedAt: '2026-05-11T00:00:00.000Z',
      failureClass: 'network',
      evidence: {
        sourceCardId: card.id,
        capabilityId: 'eastmoney_quote_health',
        statusCode: 503,
        message: 'token=secret-value',
        details: {
          authorization: 'Bearer secret-token',
        },
      },
    })

    const evidence = manager.listObservations(card.id)[0].evidence

    expect(updated.state).toBe('degraded')
    expect(updated.health.lastStatus).toBe('degraded')
    expect(evidence?.message).toBe('token=[REDACTED]')
    expect(evidence?.details).toEqual({
      authorization: '[REDACTED]',
    })
  })

  test('resolves watch bindings without exposing credentials', () => {
    const manager = createManager()
    manager.create(createAStockMarketDataSourceCard())

    const resolved = manager.resolveWatch({
      sourceCardId: 'a-stock-market-data',
      capabilityId: 'fetch_quotes',
      query: {
        symbols: ['SH000001'],
      },
      cadence: {
        type: 'interval',
        minIntervalMs: 60_000,
      },
    })

    expect(resolved.sourceCardId).toBe('a-stock-market-data')
    expect(resolved.capability.id).toBe('fetch_quotes')
    expect('credentials' in resolved).toBe(false)
  })

  test('rejects inactive private mail watch bindings and credential fields on watch', () => {
    const manager = createManager()
    manager.create(createQqMailHimalayaSourceCard())

    expect(() =>
      manager.resolveWatch({
        sourceCardId: 'qq-mail-himalaya',
        capabilityId: 'list_envelopes',
        cadence: {
          type: 'interval',
          minIntervalMs: 60_000,
        },
      }),
    ).toThrow('Watch can only consume an active SourceCard')

    manager.create(createAStockMarketDataSourceCard())
    expect(() =>
      manager.resolveWatch({
        sourceCardId: 'a-stock-market-data',
        capabilityId: 'fetch_quotes',
        query: {
          credentialRef: 'vault://not-allowed',
        },
        cadence: {
          type: 'interval',
          minIntervalMs: 60_000,
        },
      }),
    ).toThrow('must not contain credentials')
  })

  test('credential leases expose only references and inject policy', () => {
    const manager = createManager()
    manager.create(createQqMailHimalayaSourceCard())

    const lease = manager.createCredentialLease('qq-mail-himalaya', 'qq-mail-local-profile')

    expect(lease.credentialRef).toBe('external:himalaya/account/qq')
    expect(lease.injectAs).toBe('profileSession')
    expect(lease.scopes).toEqual(['mail.metadata.read'])
    expect(JSON.stringify(lease)).not.toContain('password')
  })
})
