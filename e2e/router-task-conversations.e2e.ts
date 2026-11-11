import type {
  MandateTaskDetail,
  RouterSurfaceAction,
  RouterWorkspaceSnapshot,
  RouterWorkspaceTask,
  TriggerConversationAnswer,
  TriggerConversationScope,
  TriggerConversationTurn,
  TriggerInboxItem,
  TriggerRoutingSettingsSnapshot,
} from '@zero-os/shared'
import {
  buildRouterReplySurface,
  buildRouterSurface,
} from '../apps/server/src/triggers/router-surface'
import { expect, test } from './fixtures'

const event: TriggerInboxItem = {
  id: 61,
  source: 'github',
  scope: 'example/release',
  eventId: 'run:11:1:failure',
  title: '共同的构建失败事件',
  summary: '同一次构建被两个目的不同的委托命中。',
  occurredAt: '2026-11-04T01:00:00Z',
  receivedAt: '2026-11-04T01:01:00Z',
}
const settings: TriggerRoutingSettingsSnapshot = {
  revision: 1,
  settings: {
    enabled: true,
    timeZone: 'Asia/Shanghai',
    workdays: [1, 2, 3, 4, 5],
    workStart: '09:00',
    workEnd: '18:00',
    duringWork: 'web',
    afterWork: 'defer',
    offDay: 'defer',
    presence: 'present',
    awayFallback: 'defer',
    weixinTarget: null,
  },
}
const taskItems: MandateTaskDetail[] = [8, 9].map((id) => ({
  id,
  mandateId: `mandate-${id}`,
  businessKey: 'run:11',
  title: id === 8 ? '发布阻塞跟踪' : '每周稳定性研究',
  eventCount: 1,
  active: true,
  paused: false,
  acknowledgedAt: null,
  sessionId: null,
  latestInboxId: event.id,
  updatedAt: event.receivedAt,
  matches: [
    {
      id,
      taskId: id,
      mandateId: `mandate-${id}`,
      inboxId: event.id,
      status: 'ready',
      summary: '构建失败',
      error: null,
      effects: [],
    },
  ],
}))

test('keeps two mandate conversations, A2UI actions and late replies separate when both match the same event', async ({
  page,
}) => {
  const histories = new Map<TriggerConversationScope, TriggerConversationTurn[]>()
  const submitted: Array<{
    scope: TriggerConversationScope
    requestId: string
    text?: string
    action?: RouterSurfaceAction
  }> = []
  const waiting = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let sequence = 0
  const purpose = (id: number) =>
    id === 8 ? '找出今天发布被阻塞的原因' : '归纳一周内构建稳定性趋势'
  function snapshot(id: number): RouterWorkspaceSnapshot {
    const scope = `task-${id}` as const
    const task = taskItems.find((row) => row.id === id)
    if (!task) throw new Error('Unknown task fixture')
    const context: RouterWorkspaceTask = {
      id,
      mandateId: task.mandateId,
      name: task.title,
      purpose: purpose(id),
      source: event.source,
      sourceScope: event.scope,
      eventCount: 1,
      active: true,
      paused: false,
      policy: {},
      deadline: null,
      urgent: false,
      matches: task.matches,
    }
    return {
      scope,
      event,
      route: null,
      settings,
      task: context,
      surface: buildRouterSurface(scope, event, null, settings.settings, [], context),
      turns: (histories.get(scope) ?? []).map((turn) => ({
        ...turn,
        surface: turn.answer
          ? buildRouterReplySurface(scope, turn.id, turn.answer, settings.revision)
          : null,
      })),
    }
  }
  await page.route('**/api/listeners/mandates/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice('/api/listeners/mandates'.length)
    if (path === '/tasks') return route.fulfill({ json: { items: taskItems } })
    if (path === '/tasks/8' || path === '/tasks/9')
      return route.fulfill({
        json: taskItems.find((row) => row.id === Number(path.split('/').at(-1))),
      })
    if (path === '/config')
      return route.fulfill({
        json: {
          revision: 1,
          settings: {
            projects: [],
            mandates: taskItems.map((row) => ({
              id: row.mandateId,
              name: row.title,
              purpose: purpose(row.id),
            })),
          },
        },
      })
    if (path === '/audit') return route.fulfill({ json: { items: [] } })
    throw new Error(`Unexpected task request ${path}`)
  })
  await page.route('**/api/listeners/workspace/**', async (route) => {
    const request = route.request()
    const [scope, operation] = new URL(request.url()).pathname
      .slice('/api/listeners/workspace/'.length)
      .split('/')
    expect(['task-8', 'task-9']).toContain(scope)
    const id = Number(scope.slice(5))
    if (request.method() === 'GET') return route.fulfill({ json: snapshot(id) })
    expect(['messages', 'actions']).toContain(operation)
    const next = { ...request.postDataJSON(), scope } as (typeof submitted)[number]
    submitted.push(next)
    if (next.text === '请处理今天的发布阻塞') {
      waiting.resolve()
      await release.promise
    }
    const answer: TriggerConversationAnswer = {
      text: id === 8 ? '发布专属答复' : next.action ? '研究专属下一步' : '研究专属答复',
    }
    const rows = histories.get(next.scope) ?? []
    histories.set(next.scope, [
      ...rows,
      {
        id: ++sequence,
        requestId: next.requestId,
        question: next.text ?? '请建议下一步',
        answer,
        status: 'completed',
        error: null,
        createdAt: event.receivedAt,
        updatedAt: event.receivedAt,
      },
    ])
    return route.fulfill({ json: snapshot(id) })
  })
  await page.goto('/router?task=8&view=chat')
  const conversation = page.getByRole('region', { name: '任务对话', exact: true })
  const rail = page.getByRole('navigation', { name: '持续任务' })
  const input = page.getByRole('textbox', { name: '给 Router 发消息' })
  const chat = page.getByRole('region', { name: '对话记录' })
  await expect(conversation).toContainText(purpose(8))
  await input.fill('请处理今天的发布阻塞')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await waiting.promise
  try {
    await rail.getByRole('link', { name: /每周稳定性研究/ }).click()
    await expect(conversation).toContainText(purpose(9))
  } finally {
    release.resolve()
  }
  await expect(chat).not.toContainText('发布专属答复')
  await input.fill('研究这一周的构建趋势')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(chat).toContainText('研究专属答复')
  await conversation.getByRole('button', { name: '建议下一步', exact: true }).click()
  await expect(chat).toContainText('研究专属下一步')
  expect(submitted.map((row) => row.scope)).toEqual(['task-8', 'task-9', 'task-9'])
  expect(submitted[2].action?.action.surfaceId).toContain('task-9')
  await input.fill('尚未提交的研究问题')
  await rail.getByRole('link', { name: /发布阻塞跟踪/ }).click()
  await expect(conversation).toContainText(purpose(8))
  await expect(chat).toContainText('发布专属答复')
  await expect(chat).not.toContainText('研究专属答复')
  await expect(input).toBeEmpty()
  await rail.getByRole('link', { name: /每周稳定性研究/ }).click()
  await expect(input).toHaveValue('尚未提交的研究问题')
  await rail.getByRole('link', { name: /发布阻塞跟踪/ }).click()
  await page.reload()
  await expect(chat).toContainText('发布专属答复')
  await expect(chat).not.toContainText('研究专属答复')
  await rail.getByRole('link', { name: /每周稳定性研究/ }).click()
  await expect(chat).toContainText('研究专属答复')
  await expect(chat).not.toContainText('发布专属答复')
  await expect(input).toBeEmpty()
  expect(submitted).toHaveLength(3)
})

test('a GitHub task conversation starts work with one click and shows its report and decision in place', async ({
  page,
}) => {
  const scope = 'task-8' as const
  const fix =
    '修复这项任务报告的问题：在 example/release 里查清原因，修改代码并运行相关测试，确认问题已经解决。'
  const turns: TriggerConversationTurn[] = []
  const posted: Array<{ path: string; body: Record<string, unknown> }> = []
  let jobReads = 0
  const task = taskItems[0]
  const context: RouterWorkspaceTask = {
    id: task.id,
    mandateId: task.mandateId,
    name: task.title,
    purpose: '找出今天发布被阻塞的原因',
    source: 'github',
    sourceScope: event.scope,
    eventCount: 1,
    active: true,
    paused: false,
    policy: {},
    deadline: null,
    urgent: false,
    matches: task.matches,
  }
  const snapshot = (): RouterWorkspaceSnapshot => ({
    scope,
    event,
    route: null,
    settings,
    task: context,
    surface: buildRouterSurface(scope, event, null, settings.settings, [], context),
    turns: turns.map((turn) => ({
      ...turn,
      surface: turn.answer ? buildRouterReplySurface(scope, turn.id, turn.answer) : null,
    })),
    quickQuestions: [
      { label: '让 Codex 修复', question: fix },
      { label: '深入分析', question: '深入分析这项任务报告的问题。' },
    ],
  })
  await page.route('**/api/listeners/mandates/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice('/api/listeners/mandates'.length)
    if (path === '/tasks') return route.fulfill({ json: { items: [task] } })
    if (path === '/tasks/8') return route.fulfill({ json: task })
    if (path === '/config')
      return route.fulfill({ json: { revision: 1, settings: { projects: [], mandates: [] } } })
    throw new Error(`Unexpected task request ${path}`)
  })
  await page.route('**/api/listeners/workspace/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.slice('/api/listeners/workspace/'.length)
    if (path === `${scope}/jobs`) {
      jobReads++
      return route.fulfill({
        json: {
          items: turns.length
            ? [
                {
                  id: 5,
                  executor: 'codex',
                  status: 'completed',
                  updatedAt: event.receivedAt,
                  verdict: '测试已修好。',
                },
              ]
            : [],
        },
      })
    }
    expect(path.startsWith(scope)).toBe(true)
    if (request.method() === 'GET') return route.fulfill({ json: snapshot() })
    const body = request.postDataJSON()
    posted.push({ path, body })
    turns.push({
      id: turns.length + 1,
      requestId: body.requestId,
      question: body.text ?? '选择：重跑发布',
      answer: {
        text: '派工 #5（Codex · example/release）已完成。',
        job: {
          id: 5,
          executor: 'codex',
          status: 'completed',
          attempt: 1,
          repository: event.scope,
          result: '完整的执行记录',
          report: {
            verdict: '测试已修好。',
            done: ['修改了 release.yml'],
            decision: {
              question: '现在重跑发布吗？',
              options: ['重跑发布', '先不重跑'],
              recommended: 0,
            },
          },
          ...(body.action && { continued: true as const }),
        },
      },
      status: 'completed',
      error: null,
      createdAt: event.receivedAt,
      updatedAt: event.receivedAt,
    })
    return route.fulfill({ json: snapshot() })
  })
  // The task page is visited first, so its (empty) job list is already cached when work starts.
  await page.goto('/router?task=8')
  await expect(page.getByRole('region', { name: '任务时间线' })).toContainText('发布阻塞跟踪')
  await expect.poll(() => jobReads).toBe(1)
  await expect(page.getByRole('list', { name: '派工记录' })).toHaveCount(0)
  const views = page.getByRole('navigation', { name: '任务视图' })
  await views.getByRole('link', { name: '任务对话' }).click()
  const conversation = page.getByRole('region', { name: '任务对话', exact: true })
  const quick = conversation.getByRole('group', { name: '派工快捷操作' })
  await expect(quick.getByRole('button')).toHaveText(['让 Codex 修复', '深入分析'])
  await quick.getByRole('button', { name: '让 Codex 修复' }).click()
  const chat = page.getByRole('region', { name: '对话记录' })
  await expect(chat.locator('.rw-verdict')).toHaveText('测试已修好。')
  await expect(chat.getByText('修改了 release.yml')).toBeVisible()
  expect(posted[0]).toMatchObject({ path: `${scope}/messages`, body: { text: fix } })
  await chat.getByRole('button', { name: /重跑发布（推荐）/ }).click()
  await expect(chat.getByText('选择：重跑发布')).toBeVisible()
  expect(posted[1]).toMatchObject({ path: `${scope}/actions` })
  // Back on the task page without a reload, the job started in the conversation is listed.
  await views.getByRole('link', { name: '时间线' }).click()
  const jobs = page.getByRole('list', { name: '派工记录' })
  await expect(jobs).toContainText('派工 #5')
  await expect(jobs).toContainText('测试已修好。')
})
