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

  test('rejects unsafe ids before touching source card paths', () => {
    const manager = createManager()
    manager.create(createAStockMarketDataSourceCard())

    expect(() => manager.get('../a-stock-market-data')).toThrow('sourceCardId must be')
    expect(() => manager.listObservations('../a-stock-market-data')).toThrow('sourceCardId must be')
    expect(() =>
      manager.recordObservation({
        id: '../evil',
        sourceCardId: 'a-stock-market-data',
        capabilityId: 'fetch_quotes',
        kind: 'data',
        data: {
          rows: 1,
        },
      }),
    ).toThrow('observation.id must be')
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

  test('rejects private metadata-only body and attachment observations', () => {
    const manager = createManager()
    manager.create(createQqMailHimalayaSourceCard())

    expect(() =>
      manager.recordObservation({
        sourceCardId: 'qq-mail-himalaya',
        capabilityId: 'list_envelopes',
        kind: 'data',
        data: {
          envelopeId: 'safe-metadata-id',
          body: 'private mail body must not persist',
        },
      }),
    ).toThrow('cannot persist body or attachment content')

    expect(() =>
      manager.recordObservation({
        sourceCardId: 'qq-mail-himalaya',
        capabilityId: 'list_envelopes',
        kind: 'data',
        data: {
          envelopeId: 'safe-metadata-id',
          attachments: [{ name: 'bill.pdf', fileBytes: 'private-bytes' }],
        },
      }),
    ).toThrow('cannot persist body or attachment content')

    expect(manager.listObservations('qq-mail-himalaya')).toHaveLength(0)
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

  test('rejects undeclared health check results', () => {
    const manager = createManager()
    const card = manager.create(createAStockMarketDataSourceCard())

    expect(() =>
      manager.recordHealthResult(card.id, {
        checkId: 'unknown_health_check',
        status: 'passed',
        checkedAt: '2026-05-11T00:00:00.000Z',
        evidence: {
          sourceCardId: card.id,
          capabilityId: 'unknown_health_check',
        },
      }),
    ).toThrow('is not declared')
  })

  test('recovers degraded active sources back to active on healthy check', () => {
    const manager = createManager()
    const card = manager.create(createAStockMarketDataSourceCard())

    const degraded = manager.recordHealthResult(card.id, {
      checkId: 'eastmoney_quote_health',
      status: 'failed',
      checkedAt: '2026-05-11T00:00:00.000Z',
      failureClass: 'network',
      evidence: {
        sourceCardId: card.id,
        capabilityId: 'eastmoney_quote_health',
      },
    })

    const recovered = manager.recordHealthResult(card.id, {
      checkId: 'eastmoney_quote_health',
      status: 'passed',
      checkedAt: '2026-05-11T00:05:00.000Z',
      evidence: {
        sourceCardId: card.id,
        capabilityId: 'eastmoney_quote_health',
      },
    })

    expect(degraded.state).toBe('degraded')
    expect(recovered.state).toBe('active')
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
