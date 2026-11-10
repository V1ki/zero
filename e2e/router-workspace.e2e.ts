import type { Page } from '@playwright/test'
import type {
  RouterSurfaceAction,
  RouterWorkspaceSnapshot,
  TriggerConversationAnswer,
  TriggerConversationScope,
  TriggerConversationTurn,
  TriggerInboxItem,
  TriggerRouteRecord,
  TriggerRoutingSettingsSnapshot,
} from '@zero-os/shared'
import {
  buildRouterReplySurface,
  buildRouterSurface,
} from '../apps/server/src/triggers/router-surface'
import { expect, test } from './fixtures'

const item: TriggerInboxItem = {
  id: 41,
  source: 'github',
  scope: 'example/releases',
  eventId: 'checks:build:27',
  title: '发布构建校验失败',
  summary: '发布分支的构建校验未通过，错误发生在资源检查步骤。',
  occurredAt: '2026-11-03T03:01:00Z',
  receivedAt: '2026-11-03T03:02:00Z',
}
const routeRecord: TriggerRouteRecord = {
  inboxId: item.id,
  origin: 'subscription',
  status: 'web',
  sessionId: 'fixture-agent-run',
  agent: { summary: '资源检查失败，本次发布未完成。' },
  decision: { destination: 'web', reason: '已选择网页提醒，本时段有近期网页操作。' },
  settingsRevision: 2,
  firstDeferred: null,
  weixinTarget: null,
  error: null,
  updatedAt: item.receivedAt,
}
const prefs: TriggerRoutingSettingsSnapshot = {
  revision: 2,
  settings: {
    enabled: true,
    timeZone: 'Asia/Shanghai',
    workdays: [1, 2, 3, 4, 5],
    workStart: '09:00',
    workEnd: '18:00',
    duringWork: 'web',
    afterWork: 'defer',
    offDay: 'defer',
    presence: 'auto',
    awayFallback: 'defer',
    weixinTarget: null,
  },
}

interface Submission {
  scope: TriggerConversationScope
  requestId: string
  text?: string
  action?: RouterSurfaceAction
  retry?: boolean
}
async function mockWorkspace(
  page: Page,
  reply: (submitted: Submission) => Promise<TriggerConversationAnswer | { error: string }>,
  settings = prefs,
) {
  const history = new Map<TriggerConversationScope, TriggerConversationTurn[]>()
  const submissions: Submission[] = []
  function snapshot(scope: TriggerConversationScope): RouterWorkspaceSnapshot {
    const event = scope === item.id ? item : null
    const route = event ? routeRecord : null
    return {
      scope,
      event,
      route,
      settings,
      surface: buildRouterSurface(
        scope,
        event,
        route,
        settings.settings,
        event ? ['inspect_github', 'compare_runs'] : [],
      ),
      turns: (history.get(scope) ?? []).map((turn) => ({
        ...turn,
        surface: turn.answer ? buildRouterReplySurface(scope, turn.id, turn.answer) : null,
      })),
    }
  }
  await page.route('**/api/listeners/workspace-events?*', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: item.id,
            source: item.source,
            title: item.title,
            receivedAt: item.receivedAt,
            status: 'web',
          },
        ],
      },
    }),
  )
  await page.route('**/api/listeners/workspace/**', async (route) => {
    const req = route.request()
    const [rawScope, operation] = new URL(req.url()).pathname
      .slice('/api/listeners/workspace/'.length)
      .split('/')
    const scope = rawScope === 'general' ? 'general' : Number(rawScope)
    if (scope !== 'general' && scope !== item.id)
      return route.fulfill({ status: 404, json: { error: '事件不存在' } })
    if (req.method() === 'GET') return route.fulfill({ json: snapshot(scope) })
    expect(['messages', 'actions']).toContain(operation)
    const submission = { ...req.postDataJSON(), scope } as Submission
    expect(submission.requestId).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i)
    if (operation === 'messages') expect(submission.text).toBeTruthy()
    if (operation === 'actions') expect(submission.action).toBeTruthy()
    submissions.push(submission)
    const result = await reply(submission)
    const turns = history.get(scope) ?? []
    const previous = turns.find((turn) => turn.requestId === submission.requestId)
    const turn = previous ?? {
      id: turns.length + 1,
      requestId: submission.requestId,
      question: submission.text ?? '请解释这次路由。',
      createdAt: item.receivedAt,
      updatedAt: item.receivedAt,
    }
    const saved: TriggerConversationTurn =
      'error' in result
        ? { ...turn, status: 'failed', error: result.error, answer: null }
        : { ...turn, status: 'completed', error: null, answer: result }
    history.set(scope, [...turns.filter((row) => row !== previous), saved])
    if ('error' in result) return route.fulfill({ status: 502, json: result })
    return route.fulfill({ json: snapshot(scope) })
  })
  return submissions
}

test('follows a delegated job from the same conversation', async ({ page }) => {
  const job = { id: 7, executor: 'zero' as const, attempt: 1 }
  const receipt: TriggerConversationAnswer = {
    text: '派工 #7（ZeRo）已排队。',
    job: { ...job, status: 'queued' },
  }
  const submissions = await mockWorkspace(page, async ({ text }) => {
    if (text === '分析 example/tools 的发布失败') return receipt
    expect(text).toBe('查看派工 #7 的进度')
    receipt.text = '派工 #7（ZeRo）执行中。'
    receipt.job = { ...job, status: 'running' }
    return receipt
  })
  await page.goto('/router')
  const textbox = page.getByRole('textbox', { name: '给 Router 发消息' })
  const send = page.getByRole('button', { name: '发送', exact: true })
  const chat = page.getByRole('region', { name: '对话记录' })
  await textbox.fill('分析 example/tools 的发布失败')
  await send.click()
  await expect(chat).toContainText('派工 #7（ZeRo）已排队')
  await chat.getByRole('button', { name: '查询派工进度' }).click()
  await expect(chat).toContainText('派工 #7（ZeRo）执行中')
  receipt.text = '派工 #7（ZeRo）已完成。\n失败发生在测试步骤。'
  receipt.job = { ...job, status: 'completed', result: '失败发生在测试步骤。' }
  await expect(chat).toContainText('派工 #7（ZeRo）已完成')
  await expect(chat.getByRole('button', { name: '查询派工进度' })).toHaveCount(0)
  await page.reload()
  await expect(chat).toContainText('失败发生在测试步骤。')
  expect(submissions.map((submission) => submission.scope)).toEqual(Array(2).fill('general'))
})

test('opens the Router from the main navigation, handles A2UI actions and restores the selected conversation', async ({
  page,
}) => {
  const submissions = await mockWorkspace(page, async ({ action }) =>
    action
      ? { text: '工作时间使用网页提醒。', intent: 'route', points: ['工作时段内网页有活动。'] }
      : { text: '离开后，将按已设的偏好延后提醒。' },
  )
  await page.goto('/memo')
  await page.getByRole('button', { name: 'Router', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Router 工作台' })).toBeVisible()
  const rail = page.getByRole('navigation', { name: 'Router 对话与事件' })
  await rail.getByRole('link', { name: new RegExp(item.title) }).click()
  await expect(page).toHaveURL(/\/router\?event=41$/)
  await expect(rail.locator('a[aria-current="page"]')).toHaveCount(1)
  const explain = page.getByRole('button', { name: '解释这次路由', exact: true })
  await explain.click()
  const chat = page.getByRole('region', { name: '对话记录' })
  await expect(chat).toContainText('工作时间使用网页提醒。')
  await expect(chat).toContainText('工作时段内网页有活动。')
  expect(submissions[0]).toMatchObject({
    scope: item.id,
    action: {
      version: 'v0.9.1',
      action: {
        name: 'explain_route',
        surfaceId: 'router-event-41',
        sourceComponentId: 'btn-explain_route',
        context: {},
        timestamp: expect.any(String),
      },
    },
  })
  const input = page.getByRole('textbox', { name: '给 Router 发消息' })
  await input.fill('如果我离开网页呢？')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(chat).toContainText('离开后，将按已设的偏好延后提醒。')
  await rail.getByRole('link', { name: /与 Router 对话/ }).click()
  await expect(page).toHaveURL(/\/router$/)
  await expect(chat).not.toContainText('如果我离开网页呢？')
  await page.goBack()
  await page.reload()
  await expect(chat).toContainText('如果我离开网页呢？')
  await expect(chat).toContainText('离开后，将按已设的偏好延后提醒。')
  expect(submissions).toHaveLength(2)
})

test('keeps a late reply in its originating thread and retries a failed turn using the same request id', async ({
  page,
}) => {
  const release = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const submissions = await mockWorkspace(page, async (submission) => {
    if (submission.scope === item.id) {
      started.resolve()
      await release.promise
      return { text: '仅属于发布事件的分析结果。' }
    }
    if (!submission.retry) return { error: '测试模型暂时不可用' }
    return { text: '模型连接已经恢复。' }
  })
  await page.goto('/router?event=41')
  const input = page.getByRole('textbox', { name: '给 Router 发消息' })
  const send = page.getByRole('button', { name: '发送', exact: true })
  const chat = page.getByRole('region', { name: '对话记录' })
  await input.fill('分析发布事件')
  await send.click()
  await started.promise
  try {
    await page.getByRole('link', { name: /与 Router 对话/ }).click()
    await expect(page).toHaveURL(/\/router$/)
  } finally {
    release.resolve()
  }
  await input.fill('确认目前的默认偏好')
  await send.click()
  await expect(chat).toContainText('测试模型暂时不可用')
  await expect(chat).not.toContainText('仅属于发布事件的分析结果。')
  await chat.getByRole('button', { name: '重新提问' }).click()
  await expect(chat).toContainText('模型连接已经恢复。')
  expect(submissions[2]).toMatchObject({
    requestId: submissions[1].requestId,
    retry: true,
    scope: 'general',
  })
  await page.getByRole('link', { name: new RegExp(item.title) }).click()
  await expect(chat).toContainText('仅属于发布事件的分析结果。')
  await expect(chat).not.toContainText('模型连接已经恢复。')
})

test('shows the public tool trace without tool arguments', async ({ page }) => {
  const question = '现在的通知会发到哪里？'
  const recipient = 'private-recipient-for-trace-test'
  const toolSteps = [
    { name: 'list_notification_bots', ok: true },
    { name: 'preview_current_route', ok: true, arguments: { recipient } },
  ]
  const submissions = await mockWorkspace(page, async (submitted) => {
    expect(submitted.text).toBe(question)
    return { text: '当前会通过网页提醒。', toolSteps }
  })
  await page.goto('/router')
  await page.getByRole('textbox', { name: '给 Router 发消息' }).fill(question)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const chat = page.getByRole('region', { name: '对话记录' })
  await expect(chat).toContainText('当前会通过网页提醒。')
  const trace = chat.locator('details').filter({ hasText: '本轮调用了 2 次工具' })
  await trace.locator('summary').click()
  await expect(trace.getByRole('listitem')).toHaveText([
    '查询通知机器人 · 已返回',
    '预演当前去向 · 已返回',
  ])
  await expect(chat).not.toContainText(recipient)
  expect(submissions).toHaveLength(1)
})

test('mobile navigation opens the workbench and keeps event cards and chat within the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockWorkspace(page, async () => ({ text: '仅供浏览器验收。' }))
  await page.goto('/memo')
  await page.getByRole('button', { name: 'Router', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Router 工作台' })).toBeVisible()
  await page.goto('/router?event=41')
  await expect(page.getByRole('button', { name: '解释这次路由', exact: true })).toBeVisible()
  const input = page.getByRole('textbox', { name: '给 Router 发消息' })
  await input.fill('这个事件属于哪个仓库？')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('region', { name: '对话记录' })).toContainText('仅供浏览器验收。')
  const width = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }))
  expect(width.document).toBeLessThanOrEqual(width.viewport)
})

test('shows GitHub evidence and verified-source links after a scoped action', async ({ page }) => {
  const source = 'https://github.com/example/releases/actions/runs/45/attempts/1'
  const submissions = await mockWorkspace(page, async () => ({
    text: '已核对失败位置。',
    investigation: {
      kind: 'jobs',
      observedAt: '2026-10-10T09:00:00Z',
      sourceUrl: source,
      facts: [
        {
          label: 'Build',
          value: '步骤 4 · Compile',
          url: 'https://github.com/example/releases/actions/runs/45/job/23',
        },
        { label: '日志', value: '日志未能读取（HTTP 403）。' },
      ],
    },
  }))
  await page.goto('/router?event=41')
  await page.getByRole('button', { name: '查看 GitHub 事件详情' }).click()
  const chat = page.getByRole('region', { name: '对话记录' })
  await expect(chat).toContainText('步骤 4 · Compile')
  await expect(chat).toContainText('HTTP 403')
  await expect(chat.getByRole('link', { name: 'GitHub 原始记录' })).toHaveAttribute('href', source)
  await page.reload()
  await expect(chat).toContainText('2026-10-10T09:00:00Z')
  expect(submissions).toHaveLength(1)
  expect(submissions[0].action?.action.name).toBe('inspect_github')
})

test('an interrupted IM turn remains visible with its original reply channel', async ({ page }) => {
  await mockWorkspace(page, async () => ({ text: '网页答复' }))
  await page.route('**/api/listeners/workspace/41', (route) =>
    route.fulfill({
      json: {
        scope: item.id,
        event: item,
        route: routeRecord,
        settings: prefs,
        surface: buildRouterSurface(item.id, item, routeRecord, prefs.settings),
        turns: [
          {
            id: 1,
            requestId: 'im-fixture',
            question: '从钉钉追问发布情况',
            answer: null,
            surface: null,
            status: 'failed',
            error: '模型请求被中断。',
            createdAt: item.receivedAt,
            updatedAt: item.receivedAt,
          },
        ],
      } satisfies RouterWorkspaceSnapshot,
    }),
  )
  await page.goto('/router?event=41')
  const chat = page.getByRole('region', { name: '对话记录' })
  await expect(chat).toContainText('来自 IM 的提问')
  await expect(chat).toContainText('请在原会话中重新发送问题。')
  await expect(chat.getByRole('button', { name: '重新提问' })).toHaveCount(0)
})
