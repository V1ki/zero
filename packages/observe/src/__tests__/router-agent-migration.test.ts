import { expect, test } from 'bun:test'
import { TriggerStore } from '../trigger-store'

test('legacy Worker migration preserves identities and history; uncertain work stays paused across restarts', () => {
  const store = new TriggerStore(':memory:')
  try {
    const queued = store.jobs.submit('general', 'old-request', {
      executor: 'zero',
      instruction: '核实旧事项',
      audience: 'owner',
    })
    const running = store.jobs.claimNext()
    expect(running?.id).toBe(queued.id)
    expect(store.migrateRouterWork(() => true)).toBe(1)
    const link = store.ledger.workerLink(queued.id)
    if (!link) throw Error('missing migrated link')
    expect(store.ledger.getMatter('router-owner', link.matterId)?.state).toBe('paused')
    expect(store.ledger.getMatter('router-owner', link.matterId)?.context.originalInstruction).toBe(
      '核实旧事项',
    )
    expect(store.jobs.get('general', queued.id)).toEqual(running)
    expect(store.migrateRouterWork(() => true)).toBe(0)
    expect(store.ledger.searchMatters('router-owner')).toHaveLength(1)
    expect(store.ledger.listSignals('router-owner')).toEqual([])
    const denied = store.jobs.submit('general', 'foreign', {
      executor: 'zero',
      instruction: '他人的任务',
      audience: 'other',
    })
    expect(store.migrateRouterWork((job) => job.audience === 'owner')).toBe(0)
    expect(store.ledger.workerLink(denied.id)).toBeNull()
  } finally {
    store.close()
  }
})
