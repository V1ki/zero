import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'
import { RouterPublications } from '../../apps/server/src/triggers/router-publications'

type Boundary = 'queued' | 'claimed' | 'running' | 'sent' | 'sent-verified' | 'receipt' | 'answered'
const boundaries: Boundary[] = [
  'queued',
  'claimed',
  'running',
  'sent',
  'sent-verified',
  'receipt',
  'answered',
]
async function run(dir: string, stage: Boundary, interrupt: boolean) {
  const store = new TriggerStore(join(dir, 'workspace.sqlite'))
  const peer = new Database(join(dir, 'peer.sqlite'))
  peer.exec('CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, sends INTEGER NOT NULL)')
  const id = 'crash-publication'
  const transport = {
    listPersonalBots: () => [],
    getConfig: () => ({ settings: {} }),
    prepareDirectReminder: () => ({ channelId: 'fixture-feishu', audienceKey: 'verified-private' }),
    readDirectReceipt(_platform: unknown, _target: unknown, key: string) {
      return stage === 'sent-verified'
        ? (peer.query<{ id: string }, [string]>('SELECT id FROM receipts WHERE id=?').get(key)
            ?.id ?? null)
        : null
    },
    async sendDirectReminder(
      _platform: unknown,
      _target: unknown,
      _text: string,
      key: string,
      _signal: AbortSignal,
      maySend: () => boolean,
    ) {
      assert(maySend())
      peer.run('INSERT INTO receipts VALUES(?,1) ON CONFLICT(id) DO UPDATE SET sends=sends+1', [
        key,
      ])
      if (interrupt && (stage === 'sent' || stage === 'sent-verified'))
        process.kill(process.pid, 'SIGKILL')
      return { status: 'accepted' as const, receipt: key }
    },
  }
  const publications = new RouterPublications(
    store.ledger,
    transport as unknown as ConstructorParameters<typeof RouterPublications>[1],
  )
  const signal = new AbortController().signal
  try {
    if (interrupt) {
      const m = store.ledger.createMatter('router-owner', '记录交接', '保存签收记录', ['收到签收'])
      const sid = store.ledger.receiveSignal({
        principal: 'router-owner',
        scope: 'general',
        kind: 'event',
        key: 'receipt-1',
        payload: { record: 'R21' },
      })
      if (stage === 'queued') process.kill(process.pid, 'SIGKILL')
      assert.equal(store.ledger.claimSignal()?.id, sid)
      if (stage === 'claimed') process.kill(process.pid, 'SIGKILL')
      const started = store.conversations.begin('general', `signal-${sid}`, '核实签收记录')
      assert(started.kind === 'started')
      if (stage === 'running') process.kill(process.pid, 'SIGKILL')
      store.ledger.publications.prepare({
        id,
        principal: 'router-owner',
        scope: 'general',
        matterId: m.id,
        matterVersion: m.version,
        deliveries: [
          {
            channel: 'feishu',
            presentation: { title: '记录', text: 'R21 已签收', actions: [] },
            target: JSON.stringify(transport.prepareDirectReminder()),
          },
        ],
      })
      await publications.deliver('router-owner', id, signal)
      if (stage === 'receipt') process.kill(process.pid, 'SIGKILL')
      assert(
        store.conversations.finish('general', `signal-${sid}`, started.attempt, {
          text: 'R21 已签收',
        }),
      )
      if (stage === 'answered') process.kill(process.pid, 'SIGKILL')
      throw Error('Crash point not reached')
    }
    store.conversations.recoverInterrupted()
    store.ledger.recoverInterrupted(store.conversations)
    await publications.resume(signal)
    const [input] = store.ledger.listSignals('router-owner')
    const delivery = store.ledger.publications.get('router-owner', id)?.deliveries[0]
    const external = peer
      .query<{ sends: number; id: string }, []>('SELECT id,sends FROM receipts')
      .get()
    const turn = store.conversations.get('general', `signal-${input.id}`)
    if (stage === 'queued' || stage === 'claimed') {
      assert.equal(turn, null)
      assert.equal(input.state, 'pending')
      const denied = async (): Promise<never> => {
        throw Error('Unexpected external action')
      }
      const routing = new TriggerRoutingRuntime(store.routing, {
        analyze: denied,
        weixin: { listTargets: () => [], send: denied },
      })
      let calls = 0
      const workspace = new RouterWorkspaceService(
        store,
        routing,
        async () => {
          calls++
          return { text: '已核对排队线索 R21。' }
        },
        { agentIntake: true, principalFor: () => 'router-owner' },
      )
      try {
        workspace.start()
        for (
          let n = 0;
          n < 100 && store.ledger.listSignals('router-owner')[0]?.state !== 'completed';
          n++
        )
          await Bun.sleep(20)
        assert.equal(store.ledger.listSignals('router-owner')[0]?.state, 'completed')
        assert.equal(calls, 1)
      } finally {
        await workspace.close()
        await routing.close()
      }
    } else if (stage === 'answered') {
      assert.equal(input.state, 'completed')
      assert.equal(turn?.status, 'completed')
    } else {
      assert.equal(input.state, 'interrupted')
      assert.equal(turn?.status, 'failed')
      assert(input.error)
    }
    if (stage === 'sent') {
      assert.equal(delivery?.status, 'unknown')
      assert.match(delivery?.reason ?? '', /核对/)
      assert.throws(() => store.ledger.publications.retry('router-owner', id, 'feishu', null))
      assert.equal(external?.sends, 1)
    } else if (stage === 'receipt' || stage === 'answered' || stage === 'sent-verified') {
      assert.equal(delivery?.status, 'accepted')
      assert.equal(delivery?.receipt, external?.id)
      assert.equal(external?.sends, 1)
    } else assert(!external)
    return {
      stage,
      inputState: input.state,
      turn: turn?.status,
      receiptStatus: delivery?.status,
      afterResume: store.ledger.listSignals('router-owner')[0]?.state,
      sends: external?.sends ?? 0,
      externalReceipt: external?.id,
      operatorNote: delivery?.reason ?? input.error,
    }
  } finally {
    peer.close()
    store.close()
  }
}
if (process.argv[2] === 'child') await run(process.argv[3], process.argv[4] as Boundary, true)
else {
  const out = process.env.ZERO_ACCEPTANCE_OUTPUT
  assert(out)
  const proof = []
  for (const stage of boundaries) {
    const dir = join(out, stage)
    mkdirSync(dir)
    const child = Bun.spawn([process.execPath, import.meta.path, 'child', dir, stage], {
      stdout: 'ignore',
      stderr: 'pipe',
    })
    await child.exited
    assert.equal(child.signalCode, 'SIGKILL', await new Response(child.stderr).text())
    proof.push(await run(dir, stage, false))
  }
  writeFileSync(join(out, 'crash-boundaries.json'), JSON.stringify(proof, null, 2))
}
