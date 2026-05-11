import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SourceCardHealthRunner,
  SourceCardManager,
  SourceCardService,
  createAStockMarketDataSourceCard,
  createQqMailHimalayaSourceCard,
} from '../index'

const tempDirs: string[] = []

function createHarness(): {
  manager: SourceCardManager
  service: SourceCardService
  runner: SourceCardHealthRunner
} {
  const dir = mkdtempSync(join(tmpdir(), 'zero-source-card-service-'))
  tempDirs.push(dir)
  const manager = new SourceCardManager(dir)
  const service = new SourceCardService(manager)
  const runner = new SourceCardHealthRunner(service)
  return { manager, service, runner }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('SourceCardService', () => {
  test('list and get return credential metadata without credential references', () => {
    const { manager, service } = createHarness()
    manager.create(createQqMailHimalayaSourceCard())

    const listed = service.list()
    const loaded = service.get('qq-mail-himalaya')
    const text = JSON.stringify({ listed, loaded })

    expect(loaded?.credentialBindings[0]).toMatchObject({
      id: 'qq-mail-local-profile',
      bindingType: 'externalStore',
      hasReference: true,
    })
    expect(text).not.toContain('external:himalaya/account/qq')
    expect(text).not.toContain('secret-token')
  })

  test('public views strip credential references from health evidence', () => {
    const { manager, service } = createHarness()
    manager.create(createQqMailHimalayaSourceCard())

    service.recordHealthResult('qq-mail-himalaya', {
      checkId: 'himalaya_account_health',
      status: 'failed',
      checkedAt: '2026-05-11T00:00:00.000Z',
      failureClass: 'auth',
      evidence: {
        credentialRef: 'external:himalaya/account/qq',
        credentialLeaseId: 'lease_qq_mail',
        exitCode: 1,
      },
    })

    const text = JSON.stringify({
      listed: service.list(),
      loaded: service.get('qq-mail-himalaya'),
    })

    expect(text).not.toContain('external:himalaya/account/qq')
    expect(text).not.toContain('credentialRef')
    expect(text).not.toContain('credentialLeaseId')
    expect(text).toContain('"exitCode":1')
  })

  test('validate, promote, retire, recordHealthResult, and listObservations form the service surface', () => {
    const { manager, service } = createHarness()
    manager.create(createQqMailHimalayaSourceCard())

    expect(service.validateStored('qq-mail-himalaya')).toEqual({ ok: true, errors: [] })
    manager.transitionState('qq-mail-himalaya', 'verified', 'metadata validated')

    expect(service.promote('qq-mail-himalaya', 'approved metadata watch').state).toBe('active')
    expect(
      service.recordHealthResult('qq-mail-himalaya', {
        checkId: 'himalaya_account_health',
        status: 'passed',
        checkedAt: '2026-05-11T00:00:00.000Z',
        evidence: {
          sourceCardId: 'qq-mail-himalaya',
          capabilityId: 'himalaya_account_health',
        },
      }).health.lastStatus,
    ).toBe('healthy')
    expect(service.listObservations('qq-mail-himalaya')).toHaveLength(1)
    expect(service.retire('qq-mail-himalaya', 'user disabled source').state).toBe('retired')
  })
})

describe('SourceCardHealthRunner', () => {
  test('records declared health results without producing business observations', () => {
    const { manager, service, runner } = createHarness()
    manager.create(createAStockMarketDataSourceCard())

    const summary = runner.run({
      sourceCardId: 'a-stock-market-data',
      results: [
        {
          checkId: 'eastmoney_quote_health',
          status: 'passed',
          checkedAt: '2026-05-11T00:00:00.000Z',
          evidence: {
            statusCode: 200,
            schemaKeys: ['data', 'f43'],
          },
        },
      ],
    })

    const observations = service.listObservations('a-stock-market-data')

    expect(summary.recorded).toBe(1)
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      sourceCardId: 'a-stock-market-data',
      capabilityId: 'eastmoney_quote_health',
      kind: 'health_check',
    })
    expect(observations.map((observation) => observation.kind)).not.toContain('data')
    expect(JSON.stringify(observations)).not.toContain('fetch_quotes')
  })

  test('rejects health results for undeclared checks', () => {
    const { manager, runner } = createHarness()
    manager.create(createAStockMarketDataSourceCard())

    expect(() =>
      runner.run({
        sourceCardId: 'a-stock-market-data',
        results: [
          {
            checkId: 'undeclared_check',
            status: 'passed',
            checkedAt: '2026-05-11T00:00:00.000Z',
            evidence: {},
          },
        ],
      }),
    ).toThrow('is not declared')
  })
})
