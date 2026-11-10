import { afterEach, expect, mock, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type {
  RouterSurfaceAction,
  TriggerConversationAnswer,
  TriggerMandate,
} from '@zero-os/shared'
import type { RouterAgentInput } from '../router-agent'
import { RouterWorkspaceService } from '../router-workspace'

const release: TriggerMandate = {
  id: 'releases',
  name: '发布跟进',
  purpose: '判断发布是否受阻',
  source: 'wxarc',
  scope: 'team-room',
  groupBy: 'mandate',
  keyword: '',
  enabled: true,
  projectId: null,
  targets: [],
  archive: null,
  policy: { duringWork: 'web' },
  deadline: null,
  urgent: false,
}
const research: TriggerMandate = {
  ...release,
  id: 'research',
  name: '研究资料',
  purpose: '收集研究证据',
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function fixture(
  answer: (input: RouterAgentInput) => Promise<TriggerConversationAnswer> = async (input) => ({
    text: `已回答「${input.question}」`,
  }),
) {
  const store = new TriggerStore(':memory:')
  const sourceRevision = store.saveSettings(
    {
      github: { credentialRef: '', repositories: [] },
      wxarc: { sessions: [{ id: release.scope, name: '测试会话', keyword: '', enabled: true }] },
    },
    0,
  )
  store.routing.saveSettings({ ...store.routing.getSettings().settings, enabled: true }, 0)
  store.mandates.saveSettings({ projects: [], mandates: [release, research] }, 0)
  const ask = mock(answer)
  const service = new RouterWorkspaceService(
    store,
    {
      getConfig: () => store.routing.getSettings(),
      listPersonalBots: () => [],
      process: () => {
        throw new Error('Unexpected legacy route')
      },
    },
    ask,
  )
  service.start()
  cleanups.push(async () => {
    await service.close()
    store.close()
  })

  function push(eventId: string) {
    expect(
      store.commitPush({
        source: 'wxarc',
        stream: 'wxarc:team-room',
        revision: sourceRevision,
        events: [
          {
            scope: release.scope,
            eventId,
            title: '项目消息',
            summary: `资料 ${eventId}`,
            occurredAt: '2026-11-04T00:00:00.000Z',
          },
        ],
      }),
    ).toBe(true)
    for (const mandate of [release, research]) {
      const work = store.mandates.claimAnalysis(`fixture-${mandate.id}-${eventId}`)
      if (!work) throw new Error('Expected one analysis per matched mandate')
      expect(
        store.mandates.finishAnalysis(
          work.match.id,
          `${work.mandate.id}-only-analysis-${eventId}`,
          work.claimToken,
        ),
      ).toBe(true)
    }
    return store.listInbox()[0].id
  }
  const first = push('first')
  const tasks = store.mandates.listTasks()
  const releaseTask = tasks.find((task) => task.mandateId === release.id)
  const researchTask = tasks.find((task) => task.mandateId === research.id)
  if (!releaseTask || !researchTask)
    throw new Error('Expected both mandates to match the same event')
  return {
    service,
    store,
    ask,
    push,
    first,
    releaseScope: `task-${releaseTask.id}` as const,
    researchScope: `task-${researchTask.id}` as const,
  }
}

test('independent mandates sharing the first event have private Web histories, agent context and card actions', async () => {
  const { service, ask, push, first, releaseScope, researchScope } = fixture()
  const requestId = crypto.randomUUID()
  const technicalQuestion = '构建产物缺失，需要通知哪个负责人？'
  const researchQuestion = '请给研究文档补充出处。'
  const releaseTurn = await service.message(releaseScope, requestId, technicalQuestion)
  const researchTurn = await service.message(researchScope, requestId, researchQuestion)
  expect(releaseTurn.event?.id).toBe(first)
  expect(researchTurn.event?.id).toBe(first)
  expect(releaseTurn.turns.map((turn) => turn.question)).toEqual([technicalQuestion])
  expect(researchTurn.turns.map((turn) => turn.question)).toEqual([researchQuestion])
  expect(ask.mock.calls[0][0]).toMatchObject({
    history: [],
    task: { mandateId: release.id, purpose: release.purpose },
  })
  expect(ask.mock.calls[1][0]).toMatchObject({
    history: [],
    task: { mandateId: research.id, purpose: research.purpose },
  })
  expect(ask.mock.calls[0][0].sessionId).not.toBe(ask.mock.calls[1][0].sessionId)
  expect(JSON.stringify(ask.mock.calls[1][0])).not.toContain(technicalQuestion)
  expect(ask.mock.calls[0][0].task?.matches.map((m) => m.summary)).toEqual([
    'releases-only-analysis-first',
  ])
  expect(ask.mock.calls[1][0].task?.matches.map((m) => m.summary)).toEqual([
    'research-only-analysis-first',
  ])
  const releaseCard = releaseTurn.surface[1].updateComponents
  const next = releaseCard.components.find(
    (c) => c.component === 'Button' && c.action.event.name === 'suggest_next',
  )
  if (!next) throw new Error('Expected follow-up on task card')
  const action: RouterSurfaceAction = {
    version: releaseTurn.surface[0].version,
    action: {
      name: 'suggest_next',
      surfaceId: releaseCard.surfaceId,
      sourceComponentId: next.id,
      context: {},
      timestamp: new Date().toISOString(),
    },
  }
  await expect(service.action(researchScope, crypto.randomUUID(), action)).rejects.toThrow()
  expect(ask).toHaveBeenCalledTimes(2)

  const later = push('next')
  const continuation = await service.message(
    releaseScope,
    crypto.randomUUID(),
    '后续消息有没有改变判断？',
  )
  expect(continuation.event?.id).toBe(later)
  expect(continuation.task).toMatchObject({ eventCount: 2, purpose: release.purpose })
  expect(new Set(continuation.task?.matches.map((m) => m.summary))).toEqual(
    new Set(['releases-only-analysis-first', 'releases-only-analysis-next']),
  )
  expect(ask.mock.calls[2][0].history.map((turn) => turn.question)).toEqual([technicalQuestion])
  expect(ask.mock.calls[2][0].sessionId).toBe(ask.mock.calls[0][0].sessionId)
  expect(JSON.stringify(ask.mock.calls[2][0])).not.toContain(researchQuestion)
  expect(service.get(researchScope).turns.map((turn) => turn.question)).toEqual([researchQuestion])
  expect(service.get(first).turns).toEqual([])
  expect(service.get('general').turns).toEqual([])
})

test('a revoked mandate rejects new questions and discards a model answer already in flight', async () => {
  const entered = Promise.withResolvers<void>()
  const releaseAnswer = Promise.withResolvers<TriggerConversationAnswer>()
  const { store, service, ask, releaseScope, researchScope } = fixture(async () => {
    entered.resolve()
    return releaseAnswer.promise
  })
  const pending = service.message(releaseScope, crypto.randomUUID(), '请检查当前委托。')
  // Guard against an early rejection in startup, before the model callback is reached.
  await Promise.race([entered.promise, pending])
  try {
    store.mandates.saveSettings({ projects: [], mandates: [research] }, 1)
  } finally {
    releaseAnswer.resolve({ text: '不得落库的延迟回答' })
  }
  await expect(pending).rejects.toThrow()
  await expect(
    service.message(releaseScope, crypto.randomUUID(), '撤销后的新问题'),
  ).rejects.toThrow()
  expect(ask).toHaveBeenCalledTimes(1)
  const turns = store.conversations.list(releaseScope)
  expect(turns.every((turn) => turn.status !== 'pending' && turn.answer === null)).toBe(true)
  expect(turns.map((turn) => turn.question)).not.toContain('撤销后的新问题')
  expect(service.get(researchScope).turns).toEqual([])
})
