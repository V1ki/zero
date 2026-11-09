import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import {
  RouterJobPrincipals,
  fingerprint,
} from '../../apps/server/src/triggers/router-job-principal'
import { RouterJobs } from '../../apps/server/src/triggers/router-jobs'
import { createRouterRepositoryLookup } from '../../apps/server/src/triggers/router-repositories'
import { createRouterWorkTurn } from '../../apps/server/src/triggers/router-work-turn'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

const out = process.env.ZERO_ACCEPTANCE_OUTPUT
assert(out)
const path = join(out, 'workspace.sqlite')
let store = new TriggerStore(path)
const db = new Database(path)
const grants = () =>
  new RouterJobPrincipals(
    store,
    createRouterRepositoryLookup(
      (actor) => store.getRouterGithubGrant(actor),
      () => 'fixture-only',
    ),
  )
const principal = 'router-owner'
const repo = 'fixture/archive'
const settings = store.saveSettings(
  {
    github: { credentialRef: 'github_listener_fixture', repositories: [] },
    wxarc: { sessions: [{ id: 'archive', name: 'archive', enabled: true, keyword: '' }] },
  },
  0,
)
const audience = grants().capture('web', true)
const old = store.jobs.submit('general', 'legacy-reader', {
  executor: 'zero',
  instruction: '核实原档案',
  repository: repo,
  audience,
})
store.jobs.claimNext()
store.jobs.finish(old.id, old.attempt, {
  status: 'completed',
  threadId: 'fixture-thread',
  result: '收到原始文件，等待签收原件',
})
store.jobs.claimReturn()
store.jobs.settleReturn(old.id, old.attempt, 'delivered')
const initialRouting = store.routing.getSettings()
store.routing.saveSettings({ ...initialRouting.settings, enabled: true }, initialRouting.revision)
store.commitPush({
  source: 'wxarc',
  stream: 'wxarc:archive',
  revision: settings,
  events: [
    {
      eventId: 'archive-21',
      scope: 'archive',
      occurredAt: new Date().toISOString(),
      title: '档案登记',
      summary: '保留中的档案正文',
    },
  ],
})
const event = store.listInbox(1)[0]
assert(store.routing.claimAgent(event.id, 'fixture-agent'))
assert(store.routing.finishAgent(event.id, 'fixture-agent', { summary: '旧记录' }))
assert(
  store.routing.applyDecision(
    event.id,
    { destination: 'web', reason: '核对归档' },
    store.routing.getSettings().revision,
    new Date().toISOString(),
  ),
)
for (const [key, question, text] of [
  ['round1', '档案是什么状态', '等待原件'],
  ['round2', '交接依据是什么', '已有旧收据'],
]) {
  const claim = store.conversations.begin(event.id, key, question)
  assert(claim.kind === 'started')
  store.conversations.finish(event.id, key, claim.attempt, { text })
}
const restricted = store.conversations.begin(event.id, 'restricted-old', '私人仓库资料')
assert(restricted.kind === 'started')
store.conversations.finish(event.id, 'restricted-old', restricted.attempt, {
  text: '受限的旧资料',
  workAccess: { github: true, key: fingerprint(audience) },
})
store.close()
const table = db
  .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='router_job_steps'")
  .get()
assert(table)
db.exec(
  table.sql
    .replace('router_job_steps', 'legacy_steps')
    .replace(
      'executor TEXT NOT NULL',
      "executor TEXT NOT NULL CHECK(executor IN ('zero','codex'))",
    ),
)
db.exec(
  'INSERT INTO legacy_steps SELECT * FROM router_job_steps; DROP TABLE router_job_steps; ALTER TABLE legacy_steps RENAME TO router_job_steps',
)
const digest = () =>
  createHash('sha256')
    .update(
      JSON.stringify(db.query('SELECT * FROM router_job_steps ORDER BY job_id,attempt').all()),
    )
    .digest('hex')
const before = digest()
store = new TriggerStore(path)
assert.equal(digest(), before)
const principals = grants()
const migrate = () =>
  store.migrateRouterWork((job) => principals.authorized(job.scope, job.audience, job.repository))
assert.equal(migrate(), 1)
assert.equal(migrate(), 0)
const matter = store.ledger.workerLink(old.id)?.matterId
assert(matter)
store.ledger.linkSource(principal, matter, event.id, '历史档案归属已核实')
const jobs = new RouterJobs(store.jobs, {
  authorized: principals.authorized.bind(principals),
  execute: async () => ({ result: '已复核签收原件', threadId: 'fixture-thread' }),
})
const denied = async (): Promise<never> => {
  throw Error('Unexpected external operation')
}
const routing = new TriggerRoutingRuntime(store.routing, {
  analyze: denied,
  weixin: { listTargets: () => [], send: denied },
})
const ws = new RouterWorkspaceService(store, routing, denied, {
  principalFor: () => principal,
  principals,
  delegatedJobs: jobs,
  agentIntake: true,
})
ws.start()
async function resume(label: string, newForMatter?: string) {
  const reply = store.conversations.begin('general', label, '继续原档案核查')
  assert(reply.kind === 'started')
  try {
    const actions = createRouterWorkTurn(
      { principalFor: () => principal, principals, delegatedJobs: jobs },
      store,
      'general',
      'web',
      reply.turn,
      [],
      () => true,
      { authority: 'user' },
    ).actions
    const signal = new AbortController().signal
    if (newForMatter) {
      assert(actions.delegateTask)
      return await actions.delegateTask(
        { executor: 'zero', repository: repo, matterId: newForMatter, instruction: '处理原档案' },
        signal,
      )
    }
    assert(actions.continueTask)
    return await actions.continueTask(old.id, signal, '继续原档案核查')
  } finally {
    store.conversations.finish('general', label, reply.attempt, { text: '核对完毕' })
  }
}
function state(next: 'paused' | 'working' | 'cancelled') {
  assert(matter)
  const saved = store.ledger.getMatter(principal, matter)
  assert(saved)
  store.ledger.updateMatter(principal, saved.id, saved.version, {
    state: next,
    context: saved.context,
  })
}
try {
  state('paused')
  await assert.rejects(resume('paused'), /未开放/)
  assert.equal(store.jobs.get('general', old.id)?.attempt, 1)
  const retention = store.routing.getSettings()
  store.routing.saveSettings({ ...retention.settings, retentionDays: 7 }, retention.revision)
  store.retention.sweep(new Date(Date.now() + 9 * 86400000))
  assert.equal(store.getInboxItem(event.id)?.summary, '保留中的档案正文')
  const eventSnapshot = ws.get(event.id)
  writeFileSync(join(out, 'event-view.json'), JSON.stringify(eventSnapshot))
  const rounds = eventSnapshot.turns
  assert.deepEqual(
    rounds.map((t) => t.answer?.text),
    ['等待原件', '已有旧收据', '受限的旧资料'],
  )
  state('working')
  const continued = await resume('resumed')
  assert.equal(continued.id, old.id)
  assert.equal(continued.attempt, 2)
  for (let n = 0; n < 100 && store.jobs.get('general', old.id)?.status !== 'completed'; n++)
    await Bun.sleep(20)
  assert.equal(store.jobs.get('general', old.id)?.threadId, 'fixture-thread')
  const snapshot = store.getSettings()
  store.saveSettings(
    { ...snapshot.settings, github: { credentialRef: '', repositories: [] } },
    snapshot.revision,
  )
  assert(!principals.authorized('general', audience, repo))
  await assert.rejects(resume('revoked'))
  const revokedView = ws.get(event.id).turns.find((t) => t.requestId === 'restricted-old')
  assert(revokedView && !revokedView.answer?.text.includes('受限的旧资料'))
  store.saveSettings(snapshot.settings, store.getSettings().revision)
  const newAudience = principals.capture('web', true)
  assert.notEqual(newAudience, audience)
  assert(
    !principals.authorized('general', audience, repo) &&
      principals.authorized('general', newAudience, repo),
  )
  await assert.rejects(resume('regranted'))
  assert.equal(store.jobs.get('general', old.id)?.attempt, 2)
  const fresh = jobs.submit('general', 'new-authorized', {
    executor: 'zero',
    repository: repo,
    audience: newAudience,
    instruction: '查询重新授权后的资料',
  })
  assert.notEqual(fresh.id, old.id)
  state('cancelled')
  await assert.rejects(resume('cancelled', matter), /未开放/)
  writeFileSync(
    join(out, 'lifecycle.json'),
    JSON.stringify(
      {
        before,
        migratedWorkers: 1,
        originalJob: old.id,
        originalThread: 'fixture-thread',
        attempts: store.jobs
          .history('general', old.id)
          .map((j) => ({ attempt: j.attempt, status: j.status })),
        event: event.id,
        rounds: rounds.map((t) => t.answer?.text),
        regrant: '旧授权拒绝，新的授权范围可提交工作',
        freshJob: fresh.id,
        cancelled: true,
      },
      null,
      2,
    ),
  )
} finally {
  await ws.close()
  await jobs.close()
  await routing.close()
  store.close()
  db.close()
}
