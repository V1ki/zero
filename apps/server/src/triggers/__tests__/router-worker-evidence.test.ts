import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { RouterLedgerStore } from '@zero-os/observe'
import { readWorkerEvidence } from '../router-worker-capabilities'

test('evidence recovery omits repeated model context, pages completely, and remains Worker scoped', () => {
  const db = new Database(':memory:')
  try {
    const ledger = new RouterLedgerStore(db)
    const runId = ledger.begin('router-job-7', 'worker', { prompt: 'original' })
    for (let i = 0; i < 105; i++)
      ledger.append(runId, 'model_request', { text: 'large repeated model context' })
    ledger.append(runId, 'tool_result', {
      name: 'read_public_source',
      input: { url: 'https://example.com' },
      result: { success: true, output: 'verified evidence' },
    })
    ledger.end(runId, 'failed')
    const first = readWorkerEvidence(ledger, 7, runId)
    expect(first.entries).toEqual([])
    expect(first.nextAfter).toBeDefined()
    const second = readWorkerEvidence(ledger, 7, runId, first.nextAfter ?? 0)
    expect(second.entries).toHaveLength(1)
    expect(JSON.stringify(second)).not.toContain('large repeated model context')
    expect(JSON.stringify(second)).not.toContain('verified evidence')
    const ordinal = second.entries?.[0].ordinal
    if (!ordinal) throw Error('Missing evidence index')
    const original = readWorkerEvidence(ledger, 7, runId, 0, ordinal)
    expect(JSON.stringify(original)).toContain('verified evidence')
    expect(() => readWorkerEvidence(ledger, 8, runId)).toThrow('其他 Worker')
    expect(() => readWorkerEvidence(ledger, 7, runId, 0, ordinal - 1)).toThrow('可恢复')
  } finally {
    db.close()
  }
})
