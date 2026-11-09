import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type {
  RouterSurfaceAction,
  RouterTrackingResult,
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
import { createRouterUICapability } from '../apps/server/src/triggers/router-ui-capability'
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

test('inbox distinguishes own comments and shows continued Worker progress instead of pending routing', async ({
  page,
}) => {
  await mockWorkspace(page, async () => ({ text: '已收到' }))
  const external = { ...item, id: 51, title: 'Issue #202 · 用户追加评论' }
  const own = { ...item, id: 50, title: 'Issue #202 · 机器人回复', githubOwnComment: true as const }
  const activity = { state: 'running' as const, kind: 'worker_result' as const, error: null }
  const pendingRoute = { ...routeRecord, inboxId: external.id, status: 'pending' as const }
  await page.route('**/api/listeners/workspace-events?*', (route) => {
    const includeOwn = new URL(route.request().url()).searchParams.get('includeOwn') === 'true'
    return route.fulfill({
      json: {
        items: [
          { ...external, status: 'pending', activity },
          ...(includeOwn ? [{ ...own, status: 'pending' }] : []),
        ],
      },
    })
  })
  await page.route('**/api/listeners/workspace/51', (route) =>
    route.fulfill({
      json: {
        scope: 51,
        event: external,
        route: pendingRoute,
        settings: prefs,
        turns: [],
        eventActivity: activity,
        surface: buildRouterSurface(
          51,
          external,
          pendingRoute,
          prefs.settings,
          [],
          undefined,
          undefined,
          undefined,
          activity,
        ),
      },
    }),
  )
  await page.route('**/api/listeners/workspace/50', (route) =>
    route.fulfill({
      json: {
        scope: 50,
        event: own,
        route: null,
        settings: prefs,
        turns: [],
        surface: buildRouterSurface(50, own, null, prefs.settings),
      },
    }),
  )
  await page.goto('/router?event=51')
  const rail = page.getByRole('navigation', { name: 'Router 对话与事件' })
  await expect(rail).toContainText('Router 正在处理 Worker 结果')
  await expect(page.getByRole('region', { name: '事件讨论' })).toContainText(
    'Router 正在处理 Worker 结果',
  )
  await expect(rail).not.toContainText('等待分析')
  await expect(rail.getByRole('link', { name: /机器人回复/ })).toHaveCount(0)
  await page.getByLabel('显示自身产生的事件').check()
  const ownLink = rail.getByRole('link', { name: /机器人回复/ })
  await expect(ownLink).toContainText('自身产生')
  await expect(ownLink).toContainText('已记录')
  await ownLink.click()
  await expect(page.getByRole('region', { name: '事件讨论' })).toContainText('自身产生')
  await page.reload()
  await expect(page.getByRole('region', { name: '事件讨论' })).toContainText('自身产生')
})

test('the matter shows the recorded document write and a link to the signed sample', async ({
  page,
}) => {
  await mockWorkspace(page, async () => ({ text: '已写入。' }))
  const url = 'https://example.feishu.cn/docx/Q17archive'
  await page.route('**/api/listeners/router-matters*', (route) =>
    route.fulfill({
      json: [
        {
          id: 'sample-review',
          title: '核对样稿',
          goal: '交付最终样稿',
          state: 'waiting',
          criteria: ['通知读者'],
          context: {},
          version: 2,
          updatedAt: item.receivedAt,
          documents: [{ key: 'written', state: 'accepted', title: 'Q17 签收单', url }],
        },
      ],
    }),
  )
  await page.goto('/router?view=tasks&matterId=sample-review')
  const documents = page.getByRole('list', { name: '文档归档结果' })
  await expect(documents).toContainText('已写入')
  await expect(documents.getByRole('link', { name: 'Q17 签收单' })).toHaveAttribute('href', url)
})

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
  commissionStatus: () => 'pending' | 'applied' | 'expired' = () => 'expired',
  trackedEvent?: {
    event: TriggerInboxItem
    result: () => RouterTrackingResult
    notification?: () => { submittedAt: string; route: TriggerRouteRecord } | null
  },
) {
  const inboxItem = trackedEvent?.event ?? item
  const history = new Map<TriggerConversationScope, TriggerConversationTurn[]>()
  const submissions: Submission[] = []
  function snapshot(scope: TriggerConversationScope): RouterWorkspaceSnapshot {
    const event = scope === inboxItem.id ? inboxItem : null
    const notice = event && trackedEvent?.notification?.()
    const route = notice ? notice.route : event && !trackedEvent ? routeRecord : null
    return {
      scope,
      event,
      route,
      settings,
      ...(event && trackedEvent ? { trackingResult: trackedEvent.result() } : {}),
      ...(notice ? { notificationRequest: { submittedAt: notice.submittedAt } } : {}),
      surface: buildRouterSurface(
        scope,
        event,
        route,
        settings.settings,
        event ? (trackedEvent ? ['find_related_issues'] : ['inspect_github', 'compare_runs']) : [],
        undefined,
        undefined,
        event ? trackedEvent?.result() : undefined,
      ),
      turns: (history.get(scope) ?? []).map((turn) => ({
        ...turn,
        surface: turn.answer
          ? buildRouterReplySurface(
              scope,
              turn.id,
              turn.answer,
              settings.revision,
              false,
              commissionStatus(),
            )
          : null,
      })),
    }
  }
  await page.route('**/api/listeners/workspace-events?*', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: inboxItem.id,
            source: inboxItem.source,
            title: inboxItem.title,
            receivedAt: inboxItem.receivedAt,
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
    if (scope !== 'general' && scope !== inboxItem.id)
      return route.fulfill({ status: 404, json: { error: '事件不存在' } })
    if (operation === 'github-reply' && req.method() === 'GET')
      return route.fulfill({ json: { target: null } })
    if (req.method() === 'GET') return route.fulfill({ json: snapshot(scope) })
    expect(['messages', 'actions']).toContain(operation)
    const submission = { ...req.postDataJSON(), scope } as Submission
    expect(submission.requestId).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i)
    if (operation === 'messages') expect(submission.text).toBeTruthy()
    if (operation === 'actions') expect(submission.action).toBeTruthy()
    submissions.push(submission)
    const result = await reply(submission)
    if (
      (submission.action?.action.name === 'process_event' ||
        submission.action?.action.name === 'work_on_event') &&
      !('error' in result)
    )
      return route.fulfill({ json: snapshot(scope) })
    if (submission.action?.action.name === 'send_reminder' && !('error' in result)) {
      const confirmed = snapshot(scope).turns.find(
        (turn) => turn.surface?.[0].createSurface.surfaceId === submission.action?.action.surfaceId,
      )
      const original = history.get(scope)?.find((turn) => turn.id === confirmed?.id)
      if (!original?.answer?.reminder || original.answer.reminder.status !== 'draft')
        return route.fulfill({ status: 409, json: { error: '通知草稿已失效。' } })
      original.answer = result
      return route.fulfill({ json: snapshot(scope) })
    }
    if (
      (submission.action?.action.name === 'apply_preference' ||
        submission.action?.action.name === 'confirm_mandate') &&
      !('error' in result)
    )
      return route.fulfill({ json: snapshot(scope) })
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

test('opens only GitHub repository links and follows a delegated job from the same conversation', async ({
  page,
}) => {
  const job = { id: 7, executor: 'zero' as const, attempt: 1 }
  const receipt: TriggerConversationAnswer = {
    text: '派工 #7（ZeRo）已排队。',
    job: { ...job, status: 'queued' },
  }
  const submissions = await mockWorkspace(page, async ({ text }) => {
    if (text === '看看我的 GitHub 仓库')
      return {
        text: '当前 GitHub 连接可见的仓库（第 1 页）：\n1. example/releases\n2. bad/../escape\n3. example/imagined',
        repositories: { page: 1, repositories: ['example/releases', 'bad/../escape'], nextPage: 2 },
      }
    if (text === '列出我可访问的 GitHub 仓库第 2 页')
      return {
        text: '这是第二页。',
        repositories: { page: 2, repositories: ['example/tools'], nextPage: null },
      }
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
  await textbox.fill('看看我的 GitHub 仓库')
  await send.click()
  await expect(chat.getByRole('link', { name: 'example/releases' })).toHaveAttribute(
    'href',
    'https://github.com/example/releases',
  )
  await expect(chat.getByRole('link', { name: 'bad/../escape' })).toHaveCount(0)
  await expect(chat.getByRole('link', { name: 'example/imagined' })).toHaveCount(0)
  await chat.getByRole('button', { name: '查看第 2 页' }).click()
  await expect(chat).toContainText('这是第二页。')
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
  expect(submissions.map((submission) => submission.scope)).toEqual(Array(4).fill('general'))
})

test('links the verified open pull request and keeps its repository when paging', async ({
  page,
}) => {
  const repository = 'example/releases'
  const url = `https://github.com/${repository}/pull/42`
  const other = 'https://github.com/example/tools/pull/99'
  const title = '修复 <img src=x> 与 [issue](javascript:evil) 的显示'
  const firstPage = {
    repository,
    page: 1,
    nextPage: 2,
    pullRequests: [{ number: 42, title, url, draft: true }],
  }
  const plain = `${repository} 的开放 PR，第 1 页。\n#42 ${title}（草稿）\n${url}\n可以继续查看第 2 页。`
  await mockWorkspace(page, async ({ text }) => {
    if (text === '这个项目有哪些开放 PR？') return { text: plain, pullRequests: firstPage }
    expect(text).toBe('查看 example/releases 的开放 PR 第 2 页')
    return {
      text: `本页记录\n${url}\n${other}\n\n第二项查询的授权已变更。`,
      pullRequests: { ...firstPage, page: 2, nextPage: null },
    }
  })
  await page.goto('/router')
  await page.getByRole('textbox', { name: '给 Router 发消息' }).fill('这个项目有哪些开放 PR？')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const chat = page.getByRole('region', { name: '对话记录' })
  const list = chat.getByRole('region', { name: `${repository} 的开放 PR` })
  await expect(list).toContainText('第 1 页')
  await expect(list.getByRole('link', { name: `#42 ${title}` })).toHaveAttribute('href', url)
  await expect(list.getByText('草稿', { exact: true })).toBeVisible()
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list.locator('img')).toHaveCount(0)
  await expect(chat.getByText(url, { exact: true })).toHaveCount(0)
  await chat.getByRole('button', { name: '查看第 2 页 PR' }).click()
  await expect(chat).toContainText('第二项查询的授权已变更。')
  await expect(chat.getByRole('link', { name: url })).toHaveAttribute('href', url)
  await expect(chat.getByRole('link', { name: other })).toHaveCount(0)
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

test('applies a conversational preference only after the user confirms the specific A2UI proposal', async ({
  page,
}) => {
  const settings = structuredClone(prefs)
  const submissions = await mockWorkspace(
    page,
    async (submission) => {
      if (submission.action?.action.name === 'apply_preference') {
        settings.revision++
        settings.settings.presence = 'away'
        return { text: '已应用。' }
      }
      return {
        text: '可以把在场状态设为离开。',
        proposal: { key: 'presence', value: 'away' },
        proposalRevision: settings.revision,
      }
    },
    settings,
  )
  await page.goto('/router')
  await page.getByRole('textbox', { name: '给 Router 发消息' }).fill('把我的在场状态设为离开')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const button = page.getByRole('button', { name: '确认应用偏好' })
  await expect(button).toBeVisible()
  expect(submissions).toHaveLength(1)
  await page.reload()
  await expect(button).toBeVisible()
  expect(settings.settings.presence).toBe('auto')
  await button.click()
  await expect(button).toHaveCount(0)
  await expect(page.getByText('手动标记离开。网页无人时延后提醒。', { exact: true })).toBeVisible()
  expect(submissions[1].action?.action).toMatchObject({
    name: 'apply_preference',
    surfaceId: 'router-general-turn-1',
    context: {},
  })
  expect(submissions).toHaveLength(2)
})

test('an explicit send-now command shows the accepted notification and the public tool trace', async ({
  page,
}) => {
  const question = '现在发送微信通知，通知我处理 DeepSeek 的充值'
  const body = '处理 DeepSeek 的充值'
  const recipient = 'private-recipient-for-trace-test'
  const toolSteps = [
    { name: 'list_notification_bots', ok: true },
    {
      name: 'send_personal_reminder',
      ok: true,
      arguments: { recipient, text: body },
    },
    { name: 'present_ui', ok: true },
  ]
  // This fixture models the Agent choosing to present the confirmed receipt.
  // A tool call alone does not create a second, server-authored card.
  const ui = createRouterUICapability()
  await ui.tool.execute(
    {
      components: [
        { id: 'root', component: 'Column', children: ['result', 'origin', 'body'] },
        { id: 'result', component: 'Text', text: '微信平台已受理' },
        { id: 'origin', component: 'Text', text: '个人微信机器人' },
        { id: 'body', component: 'Text', text: body },
      ],
      data: {},
      actions: {},
    },
    new AbortController().signal,
  )
  const generatedUI = ui.get()
  if (!generatedUI) throw Error('Missing Router receipt surface')
  const submissions = await mockWorkspace(page, async (submitted) => {
    expect(submitted.text).toBe(question)
    expect(submitted.action).toBeUndefined()
    return {
      text: '微信平台已受理这条通知。',
      generatedUI,
      reminder: {
        platform: 'weixin',
        channelId: 'weixin-personal',
        botLabel: '个人微信机器人',
        status: 'accepted',
        text: body,
      },
      toolSteps,
    }
  })
  await page.goto('/router')
  await page.getByRole('textbox', { name: '给 Router 发消息' }).fill(question)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const chat = page.getByRole('region', { name: '对话记录' })
  const card = chat.locator(
    `[data-surface-id="${generatedUI.messages[0].createSurface.surfaceId}"]`,
  )
  await expect(card).toContainText('平台已受理')
  await expect(card).toContainText('个人微信机器人')
  await expect(card.getByText(body, { exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: '发送通知', exact: true })).toHaveCount(0)
  const trace = chat.locator('details').filter({ hasText: '查看处理过程（3 次工具调用）' })
  await trace.locator('summary').click()
  await expect(trace.getByRole('listitem')).toHaveText([
    '查询通知机器人 · 已返回',
    '发送个人通知 · 已返回',
    '组织当前界面 · 已返回',
  ])
  await expect(trace).not.toContainText(body)
  await expect(chat).not.toContainText(recipient)
  await page.reload()
  await expect(card).toContainText('平台已受理')
  await expect(card.getByRole('button', { name: '发送通知', exact: true })).toHaveCount(0)
  expect(submissions).toHaveLength(1)
})

test('a plain reminder confirmation retains the Agent answer without generating another card', async ({
  page,
}) => {
  const text = '个人微信机器人已受理提醒「核对签收单」。'
  await mockWorkspace(page, async () => ({
    text,
    toolSteps: [{ name: 'send_personal_reminder', ok: true }],
    reminder: {
      platform: 'weixin',
      channelId: 'weixin-personal',
      botLabel: '个人微信机器人',
      status: 'accepted',
      text: '核对签收单',
    },
  }))
  await page.goto('/router')
  await page.getByRole('textbox', { name: '给 Router 发消息' }).fill('现在发微信提醒我核对签收单')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const turn = page.locator('#rw-turn-1')
  await expect(turn).toContainText(text)
  await expect(turn.getByRole('region', { name: '交互卡片' })).toHaveCount(0)
})

test('an explicit Weixin draft shows the exact text and sends once after confirmation', async ({
  page,
}) => {
  const reminder = {
    platform: 'weixin' as const,
    channelId: 'weixin-personal',
    botLabel: '个人微信机器人',
    text: '处理 DeepSeek 的充值',
  }
  const question = '先帮我拟一条微信通知，内容是「处理 DeepSeek 的充值」'
  let deliveries = 0
  const submissions = await mockWorkspace(page, async (submitted) => {
    if (submitted.action) {
      expect(submitted.action.action).toMatchObject({
        name: 'send_reminder',
        surfaceId: 'router-general-turn-1',
        sourceComponentId: 'btn-send_reminder',
        context: {},
      })
      deliveries++
      return { text: '收到平台回执。', reminder: { ...reminder, status: 'accepted' } }
    }
    expect(submitted).toMatchObject({ text: question, scope: 'general' })
    return { text: '请核对提醒。', reminder: { ...reminder, status: 'draft' } }
  })
  await page.goto('/router')
  await page.getByRole('textbox', { name: '给 Router 发消息' }).fill(question)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const card = page.locator('[data-surface-id="router-general-turn-1"]')
  const confirm = card.getByRole('button', { name: '发送通知', exact: true })
  await expect(card).toContainText(reminder.botLabel)
  await expect(card.getByText(reminder.text, { exact: true })).toBeVisible()
  await expect(confirm).toBeVisible()
  await page.reload()
  await expect(confirm).toBeVisible()
  expect(deliveries).toBe(0)
  await confirm.click()
  await expect(card).toContainText('已受理')
  await expect(confirm).toHaveCount(0)
  await page.reload()
  await expect(card).toContainText('已受理')
  await expect(confirm).toHaveCount(0)
  expect(deliveries).toBe(1)
  expect(submissions).toHaveLength(2)
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

for (const kind of ['issue', 'pr'] as const) {
  test(`manual GitHub reply: ${kind === 'issue' ? 'publishes only on explicit submit and shows the bot receipt' : 'an unknown PR delivery is not repeated'}`, async ({
    page,
  }) => {
    const repository = 'example/releases'
    const author = 'zero-router[bot]'
    const url = `https://github.com/${repository}/${kind === 'issue' ? 'issues' : 'pull'}/12`
    const receiptUrl = `${url}#issuecomment-822`
    const event: TriggerInboxItem = {
      ...item,
      scope: repository,
      eventId: '92:comment:821',
      githubCommentKind: kind === 'issue' ? 'issue-comment' : 'pr-comment',
      url: `${url}#issuecomment-821`,
      title: `${kind === 'issue' ? 'Issue' : 'PR'} #12 · 新评论`,
      summary: '能否补充复现步骤？',
    }
    const body = '已复现，明天会补上详细步骤。'
    const posts: unknown[] = []
    let appBound = true
    await mockWorkspace(page, async () => ({ text: '本地对话' }))
    await page.route('**/api/listeners/workspace/41', (route) =>
      route.fulfill({
        json: {
          scope: event.id,
          event,
          route: null,
          settings: prefs,
          surface: buildRouterSurface(event.id, event, null, prefs.settings),
          turns: [],
        } satisfies RouterWorkspaceSnapshot,
      }),
    )
    await page.route('**/api/listeners/workspace/41/github-reply', (route) => {
      const req = route.request()
      if (req.method() === 'GET') {
        return route.fulfill({
          json: { target: appBound ? { repository, number: 12, kind, author, url } : null },
        })
      }
      expect(req.method()).toBe('POST')
      expect(req.headers()['if-match']).toBe(`"${author}"`)
      posts.push(req.postDataJSON())
      return kind === 'issue'
        ? route.fulfill({ json: { status: 'sent', id: 822, url: receiptUrl, author } })
        : route.fulfill({
            status: 409,
            json: { status: 'unknown', error: 'GitHub 评论发送结果待核对。请先查看原讨论。' },
          })
    })
    if (kind === 'pr') await page.clock.install()
    await page.goto('/router?event=41')
    const panel = page
      .locator('details')
      .filter({ has: page.getByText('在 GitHub 回复', { exact: true }) })
    await panel.locator('summary').click()
    await expect(panel).toContainText(repository)
    await expect(panel).toContainText('#12')
    await expect(panel).toContainText(author)
    const publish = panel.getByRole('button', { name: '发布到 GitHub', exact: true })
    await expect(publish).toBeDisabled()
    await panel.getByLabel('评论正文').fill(body)
    await expect(publish).toBeEnabled()
    expect(posts).toEqual([])
    await publish.click()
    if (kind === 'issue') {
      await expect(panel.getByRole('link', { name: '查看已发布的评论' })).toHaveAttribute(
        'href',
        receiptUrl,
      )
      await expect(panel).toContainText(author)
      appBound = false
      await Promise.all([
        page.waitForResponse(
          (r) => r.url().endsWith('/workspace/41/github-reply') && r.request().method() === 'GET',
        ),
        page.reload(),
      ])
      await expect(panel).toHaveCount(0)
    } else {
      await expect(panel).toContainText('待核对')
      await expect(panel.getByRole('link', { name: '查看已发布的评论' })).toHaveCount(0)
      await page.clock.fastForward(15_000)
    }
    expect(posts).toEqual([
      {
        requestId: expect.stringMatching(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i),
        body,
      },
    ])
  })
}

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

test('a mandate card preserves the named cross-channel destination across reload and requires confirmation', async ({
  page,
}) => {
  let saved = false
  const submissions = await mockWorkspace(
    page,
    async (s) => {
      if (s.action?.action.name === 'confirm_mandate') {
        saved = true
        return { text: '已确认' }
      }
      return {
        text: '请核对委托范围和提醒去向。',
        commission: {
          code: '001122334455',
          title: '创建委托「发布构建」',
          details: [
            '监听：github / example/release',
            '休息日：钉钉',
            '允许外发至：钉钉 / 发布会话',
          ],
          expiresAt: Date.now() + 600000,
        },
      }
    },
    prefs,
    () => (saved ? 'applied' : 'pending'),
  )
  await page.goto('/router')
  await page
    .getByRole('textbox', { name: '给 Router 发消息' })
    .fill('替我跟踪发布构建，周末通知钉钉')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const card = page.locator('[data-surface-id="router-general-turn-1"]')
  await expect(card.getByRole('heading', { name: '创建委托「发布构建」' })).toBeVisible()
  await expect(card).toContainText('允许外发至：钉钉 / 发布会话')
  expect(saved).toBe(false)
  await page.reload()
  await card.getByRole('button', { name: '确认此委托变更' }).click()
  await expect(card).toContainText('已确认并保存。')
  await expect(card.getByRole('button')).toHaveCount(0)
  expect(submissions[1].action?.action).toMatchObject({
    name: 'confirm_mandate',
    surfaceId: 'router-general-turn-1',
  })
})

test('root shows tracked GitHub worker updates and flags questions without opening an IM', async ({
  page,
}) => {
  const submissions = await mockWorkspace(page, async () => ({ text: '意外的对话动作' }))
  const result: RouterTrackingResult = {
    id: 2,
    inboxId: item.id,
    repository: 'acme/demo',
    title: 'PR #8 · 更新安装脚本',
    url: 'https://github.com/acme/demo/pull/8',
    kind: 'pr',
    occurredAt: item.occurredAt,
    status: 'running',
    needsAttention: false,
    result: null,
  }
  let done = false
  await page.route('**/api/listeners/tracking-results?*', (route) =>
    route.fulfill({
      json: {
        items: [
          done
            ? {
                ...result,
                status: 'completed',
                needsAttention: true,
                attentionQuestion: '应合并到哪个目标分支？',
                result: '维护者需要确认目标分支。',
              }
            : result,
          {
            ...result,
            id: 1,
            inboxId: 40,
            kind: 'issue',
            status: 'completed',
            url: 'https://outside.invalid/pr/2',
            title: 'Issue #2 · 文档排版',
            result: '已记录排版问题。',
          },
          {
            ...result,
            id: 3,
            inboxId: 39,
            kind: 'issue-comment',
            status: 'completed',
            url: 'https://github.com/acme/demo/issues/2#issuecomment-48',
            title: 'Issue #2 · 新评论',
          },
        ],
      },
    }),
  )
  await page.goto('/router')
  const section = page.getByRole('region', { name: 'Router 跟进动态' })
  await expect(section.getByText('正在处理')).toBeVisible()
  await expect(section.getByRole('link', { name: result.title })).toHaveAttribute(
    'href',
    'https://github.com/acme/demo/pull/8',
  )
  await expect(section.getByText('Issue #2 · 文档排版')).toBeVisible()
  await expect(section.getByRole('link', { name: 'Issue #2 · 文档排版' })).toHaveCount(0)
  await expect(section.getByText('Issue 评论', { exact: true })).toBeVisible()
  await expect(section.getByRole('link', { name: 'Issue #2 · 新评论' })).toHaveAttribute(
    'href',
    'https://github.com/acme/demo/issues/2#issuecomment-48',
  )
  done = true
  await section.getByRole('button', { name: '刷新跟踪动态' }).click()
  await expect(section.getByText('待确认 · 摘要已完成')).toBeVisible()
  await expect(section.getByText('应合并到哪个目标分支？')).toBeVisible()
  await section.getByText('查看待确认事项').click()
  await expect(section.getByText('维护者需要确认目标分支。')).toBeVisible()
  await section
    .getByRole('link', { name: `查看事件 #${item.id}` })
    .first()
    .click()
  await expect(section).toHaveCount(0)
  await expect(page).toHaveURL(/event=41/)
  expect(submissions).toHaveLength(0)
})

const trackedIssue = {
  ...item,
  id: 4,
  eventId: '123:comment:58',
  githubCommentKind: 'issue-comment',
  title: 'Issue #181 · 新评论',
  summary: '维护者想找到之前提到新版依赖发布延迟的 Issue。',
  url: 'https://github.com/example/releases/issues/181#issuecomment-58',
} satisfies TriggerInboxItem
const summary = '评论提到新版依赖发布延迟。相关历史 Issue 尚未检索。'
function issueResult(done: boolean): RouterTrackingResult {
  return {
    id: 7,
    inboxId: trackedIssue.id,
    repository: trackedIssue.scope,
    title: trackedIssue.title,
    url: trackedIssue.url,
    occurredAt: trackedIssue.occurredAt,
    kind: 'issue-comment',
    status: done ? 'completed' : 'running',
    needsAttention: false,
    result: done ? summary : null,
  }
}

test('keeps a tracked Issue worker and its follow-up in the selected event across navigation and reload', async ({
  page,
}) => {
  const event = trackedIssue
  const question = '这次是否查过历史 Issue？'
  const answer = '这次只整理了原评论，还没有检索历史 Issue。'
  let done = false
  const result = () => issueResult(done)
  const submissions = await mockWorkspace(page, async () => ({ text: answer }), prefs, undefined, {
    event,
    result,
  })
  await page.route('**/api/listeners/tracking-results?*', (route) =>
    route.fulfill({ json: { items: [result()] } }),
  )
  await page.goto('/router')
  const listing = page.getByRole('region', { name: 'Router 跟进动态' })
  await listing.getByRole('link', { name: '查看事件 #4' }).click()
  await expect(page).toHaveURL(/\/router\?event=4$/)
  const chat = page.getByRole('region', { name: '对话记录' })
  await expect(chat.getByRole('article', { name: '处理进展' })).toBeVisible()
  const worker = chat.getByRole('article', { name: '自动生成的摘要' })
  done = true
  await expect(worker).toContainText(summary, { timeout: 8_000 })
  await expect(worker).toContainText('摘要已完成')
  await worker.getByRole('button', { name: '追问这条摘要' }).click()
  const textbox = page.getByRole('textbox', { name: '给 Router 发消息' })
  await expect(textbox).toBeFocused()
  expect(submissions).toHaveLength(0)
  await textbox.fill(question)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(chat).toContainText(answer)
  expect(submissions).toMatchObject([{ scope: event.id, text: question }])
  await page.reload()
  await expect(worker).toContainText(summary)
  await expect(chat).toContainText(question)
  await expect(chat).toContainText(answer)
  await page.getByRole('link', { name: '与 Router 对话', exact: true }).click()
  await expect(worker).toHaveCount(0)
  await expect(chat).not.toContainText(question)
  await expect(listing).toContainText('摘要已完成')
  expect(submissions).toHaveLength(1)
})

test('shows the reason a follow-up went back to its original Worker and the evidence it returned', async ({
  page,
}) => {
  const row: RouterTrackingResult = {
    ...issueResult(true),
    attempt: 2,
    result: '已核对原帖补充的链接。',
    work: {
      outcome: 'resolved',
      followup: { kind: 'continue', decision: 'act', reason: '新评论补充了原问题的仓库证据。' },
      sources: [{ label: '原讨论', url: trackedIssue.url }],
      steps: [{ tool: 'inspect_github', ok: true }],
    },
    previous: {
      attempt: 1,
      status: 'completed',
      result: '等待作者提供复现信息。',
      work: { outcome: 'needs_input', steps: [], sources: [] },
    },
  }
  await mockWorkspace(page, async () => ({ text: '' }), prefs, undefined, {
    event: trackedIssue,
    result: () => row,
  })
  await page.goto('/router?event=4')
  const work = page.getByRole('article', { name: '处理进展' })
  await expect(work).toContainText('Worker #7 · 第 2 轮')
  await expect(work).toContainText('已有事项 · 原 Worker 接续办理')
  await expect(work).toContainText('新评论补充了原问题的仓库证据。')
  await expect(work.getByRole('link', { name: '原讨论' })).toHaveAttribute('href', trackedIssue.url)
  await work.getByText(/上一次办理 · 第 1 轮/).click()
  await expect(work.getByText('等待作者提供复现信息。')).toBeVisible()
})

test('pages follow-up events by inbox id when several belong to the same Worker', async ({
  page,
}) => {
  await mockWorkspace(page, async () => ({ text: '' }))
  const cursors: (string | null)[] = []
  await page.route('**/api/listeners/tracking-results?*', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('beforeId')
    cursors.push(cursor)
    const ids = cursor ? [34] : Array.from({ length: 15 }, (_, i) => 49 - i)
    return route.fulfill({
      json: {
        items: ids.map((inboxId) => ({
          ...issueResult(true),
          inboxId,
          title: `同一事项线索 ${inboxId}`,
        })),
      },
    })
  })
  await page.goto('/router')
  const list = page.getByRole('region', { name: 'Router 跟进动态' })
  await list.getByRole('button', { name: '展开较早记录' }).click()
  await list.getByRole('button', { name: '加载更多跟踪动态' }).click()
  await expect(list.getByText('同一事项线索 34')).toBeVisible()
  await expect(list.getByRole('listitem')).toHaveCount(16)
  expect(cursors).toContain('35')
})

test('displays private archive observations and links only to their own inbox event', async ({
  page,
}) => {
  const reason = '这条归档仅记录了会议时间。'
  const archive: RouterTrackingResult = {
    ...issueResult(true),
    source: 'wxarc',
    kind: 'archive-message',
    repository: '',
    title: '归档消息',
    attempt: 1,
    result: reason,
    work: {
      followup: { kind: 'new', decision: 'observe', reason },
      outcome: 'observed',
      steps: [],
      sources: [
        { label: '本机原文', url: '/router?event=4' },
        { label: '其他事件', url: '/router?event=42' },
        { label: '外部链接', url: 'https://github.com/example/releases/issues/181' },
      ],
    },
  }
  const event: TriggerInboxItem = { ...trackedIssue, source: 'wxarc', title: archive.title }
  await mockWorkspace(page, async () => ({ text: '' }), prefs, undefined, {
    event,
    result: () => archive,
  })
  await page.route('**/api/listeners/tracking-results?*', (route) =>
    route.fulfill({ json: { items: [archive] } }),
  )
  await page.goto('/router')
  const list = page.getByRole('region', { name: 'Router 跟进动态' })
  await expect(list.getByText('微信归档')).toBeVisible()
  await list.getByText('查看记录原因').click()
  await expect(list.getByText(reason)).toBeVisible()
  await list.getByRole('link', { name: '本机原文' }).click()
  const work = page.getByRole('article', { name: '处理进展' })
  await expect(page.locator('#rw-source-text')).toBeVisible()
  await expect(work).toContainText('新线索 · 留作记录')
  await expect(work.getByRole('link', { name: '其他事件' })).toHaveCount(0)
  await expect(work.getByRole('link', { name: '外部链接' })).toHaveCount(0)
  await expect(work.getByRole('button', { name: '补充办理要求' })).toHaveCount(0)
})

test('keeps a manual notification receipt separate from a requested historical Issue lookup', async ({
  page,
}) => {
  const event = trackedIssue
  const evidenceUrl = 'https://github.com/example/releases/issues/159#issuecomment-50'
  let routed = false
  const submissions = await mockWorkspace(
    page,
    async ({ action }) => {
      if (action?.action.name === 'process_event') {
        routed = true
        return { text: '已选择网页通知。' }
      }
      expect(action?.action.name).toBe('find_related_issues')
      return {
        text: '找到了提及发布延迟的历史讨论。',
        investigation: {
          kind: 'related-issues',
          observedAt: event.receivedAt,
          sourceUrl: event.url,
          facts: [
            {
              label: 'Issue #159 · 评论证据',
              value: '维护者提到依赖发布后仍不可见。',
              url: evidenceUrl,
            },
          ],
        },
      }
    },
    prefs,
    undefined,
    {
      event,
      result: () => issueResult(true),
      notification: () =>
        routed
          ? {
              submittedAt: event.receivedAt,
              route: { ...routeRecord, inboxId: event.id, origin: 'manual' },
            }
          : null,
    },
  )
  await page.goto('/router?event=4')
  const chat = page.getByRole('region', { name: '对话记录' })
  await page.getByRole('button', { name: '分析并路由通知', exact: true }).click()
  const notice = chat.getByRole('article', { name: '通知处理记录' })
  await expect(notice).toContainText('分析并路由通知')
  await expect(chat.getByRole('link', { name: /Issue #159/ })).toHaveCount(0)
  await page.getByRole('button', { name: '查找相关历史 Issue', exact: true }).click()
  const evidence = chat.getByRole('link', { name: /Issue #159/ })
  await expect(evidence).toHaveAttribute('href', evidenceUrl)
  await page.reload()
  await expect(notice).toBeVisible()
  await expect(evidence).toHaveAttribute('href', evidenceUrl)
  await expect(chat.getByRole('article', { name: '自动生成的摘要' })).toContainText(summary)
  expect(submissions.map(({ scope, action }) => [scope, action?.action.name])).toEqual([
    [4, 'process_event'],
    [4, 'find_related_issues'],
  ])
})

test('hands the observed event to the Worker once and keeps the verified answer on the original event', async ({
  page,
}) => {
  const proof = 'https://github.com/example/releases/issues/159#issuecomment-50'
  const resultText = '此前在 #159 的讨论中确认过这个现象。'
  let state: RouterTrackingResult = issueResult(true)
  const submissions = await mockWorkspace(
    page,
    async ({ action }) => {
      expect(action?.action.name).toBe('work_on_event')
      state = {
        ...issueResult(false),
        attempt: 2,
        workOrigin: 'manual',
        previous: { attempt: 1, status: 'completed', result: summary },
      }
      return { text: '' }
    },
    prefs,
    undefined,
    { event: trackedIssue, result: () => state },
  )
  await page.goto('/router?event=4')
  const log = page.getByRole('region', { name: '对话记录' })
  await expect(log.getByRole('article', { name: '自动生成的摘要' })).toContainText(summary)
  await page.getByRole('button', { name: '让 Worker 处理', exact: true }).click()
  const work = log.getByRole('article', { name: '处理进展' })
  await expect(work).toBeVisible()
  await expect(work).not.toContainText('已办结')
  await expect(work.getByText(/上一次摘要/)).toBeVisible()
  await page.reload()
  await expect(work).toBeVisible()
  state = {
    ...state,
    status: 'completed',
    result: resultText,
    work: {
      outcome: 'resolved',
      steps: [{ tool: 'find_related_issues', ok: true }],
      sources: [{ label: 'Issue #159 · 评论证据', url: proof }],
    },
  }
  await expect(work).toContainText('已办结')
  await expect(work).toContainText(resultText)
  const evidence = work.getByRole('navigation', { name: 'Worker 核对的来源' }).getByRole('link')
  await expect(evidence).toHaveAttribute('href', proof)
  await work.getByText(/上一次摘要/).click()
  await expect(work.getByText(summary, { exact: true })).toBeVisible()
  await page.reload()
  await expect(evidence).toHaveAttribute('href', proof)
  expect(submissions.map(({ scope, action }) => [scope, action?.action.name])).toEqual([
    [trackedIssue.id, 'work_on_event'],
  ])
})

test('an automatically handled request that needs input stays actionable without pretending it was resolved', async ({
  page,
}) => {
  const question = '需要比较哪个目标版本？'
  const incomplete = {
    ...issueResult(true),
    needsAttention: true,
    attentionQuestion: question,
    result: '原讨论没有给出目标版本，暂时无法完成比较。',
    work: {
      outcome: 'needs_input',
      steps: [{ tool: 'inspect_github', ok: true }],
      sources: [],
    },
  } satisfies RouterTrackingResult
  const submissions = await mockWorkspace(page, async () => ({ text: '' }), prefs, undefined, {
    event: trackedIssue,
    result: () => incomplete,
  })
  await page.goto('/router?event=4')
  const work = page.getByRole('article', { name: '处理进展' })
  await expect(work).toContainText('尚未完成')
  await expect(work).toContainText(question)
  await expect(work).not.toContainText('已办结')
  await expect(work.getByRole('link')).toHaveCount(0)
  expect(submissions).toHaveLength(0)
})

test('selects ordinary GitHub comment subscriptions in the main Router chat', async ({ page }) => {
  const submissions = await mockWorkspace(page, async () => ({ text: '已更新评论跟踪。' }))
  await page.route('**/api/listeners/config', (route) => {
    expect(route.request().method()).toBe('GET')
    return route.fulfill({
      json: {
        revision: 1,
        settings: {
          github: { routerTrackingEnabled: true, repositories: [{ name: 'example/releases' }] },
        },
      },
    })
  })
  await page.goto('/router')
  await page.getByText('跟踪 GitHub 普通评论', { exact: true }).click()
  const form = page.getByRole('form', { name: '跟踪 GitHub 普通评论' })
  const repository = form.getByRole('combobox', { name: '目标仓库' })
  const send = form.getByRole('button', { name: '发送跟踪请求' })
  await expect(form.locator('datalist option')).toHaveAttribute('value', 'example/releases')
  await repository.fill('example/releases')
  await expect(send).toBeDisabled()
  await form.getByLabel('Issue 普通评论').check()
  await expect(send).toBeEnabled()
  expect(submissions).toHaveLength(0)
  await send.click()
  await expect(page.getByText('已更新评论跟踪。')).toBeVisible()
  expect(submissions[0]).toMatchObject({
    scope: 'general',
    text: '跟踪 example/releases 的 Issue 普通评论',
  })
  await form.getByLabel('PR 普通评论').check()
  await send.click()
  await expect.poll(() => submissions.length).toBe(2)
  expect(submissions[1].text).toBe('跟踪 example/releases 的 Issue 和 PR 普通评论')
  await form.getByLabel('Issue 普通评论').uncheck()
  await repository.fill('example/new-repository')
  await send.click()
  await expect.poll(() => submissions.length).toBe(3)
  expect(submissions[2].text).toBe('跟踪 example/new-repository 的 PR 普通评论')
  await page.goto('/router?event=41')
  await expect(page.getByText('跟踪 GitHub 普通评论')).toHaveCount(0)
})

test('Router answers keep the conclusion, limitations and readable structure on desktop and mobile', async ({
  page,
}, testInfo) => {
  await mockWorkspace(page, async () => ({
    text: '找到了相关记录，但**还不能确认原因**。\n\n因为缺少最新测试结果，问题仍未解决。\n\n1. 已核对历史记录。\n2. 还需检查当前日志。\n\n[查看依据](https://example.com/evidence)\n\n| 方案 | 已知限制 |\n| --- | --- |\n| 继续核查 | 尚未取得日志 |',
  }))
  await page.goto('/router')
  await page.getByRole('textbox', { name: '给 Router 发消息' }).fill('说明进展和还没确认的部分')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const result = page.getByRole('region', { name: '对话记录' }).locator('.router-message')
  await expect(result.locator('strong')).toHaveText('还不能确认原因')
  await expect(result.locator('ol li')).toHaveCount(2)
  await expect(result.getByRole('link', { name: '查看依据' })).toHaveAttribute(
    'href',
    'https://example.com/evidence',
  )
  await expect(result.getByRole('table')).toContainText('尚未取得日志')
  await page.screenshot({ path: testInfo.outputPath('router-reading-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(result).toContainText('问题仍未解决')
  expect(await result.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await result.screenshot({ path: testInfo.outputPath('router-reading-mobile.png') })
})

test('Agent-generated controls and per-platform receipts remain readable in chat and in the selected event', async ({
  page,
}) => {
  const { createRouterUICapability } = await import(
    '../apps/server/src/triggers/router-ui-capability'
  )
  const ui = createRouterUICapability()
  ui.tool.execute(
    {
      components: [
        { id: 'root', component: 'Column', children: ['finding', 'act'] },
        {
          id: 'finding',
          component: 'Text',
          text: '资料已核对；缺少真实复测记录，不能确认问题解决。',
        },
        { id: 'label', component: 'Text', text: '补充复测结果' },
        {
          id: 'act',
          component: 'Button',
          child: 'label',
          action: { event: { name: 'router_input' } },
        },
      ],
      data: {},
      actions: {
        act: { instruction: '补充复测结果', matterId: 'matter-fixture', matterVersion: 1 },
      },
    },
    new AbortController().signal,
  )
  const generatedUI = ui.get()
  if (!generatedUI) throw Error('missing fixture UI')
  const submissions: unknown[] = []
  const publication = {
    id: 'a'.repeat(64),
    principal: 'router-owner',
    matterId: 'matter-fixture',
    matterVersion: 1,
    scope: String(item.id),
    createdAt: item.receivedAt,
    deliveries: [
      {
        channel: 'web',
        presentation: {
          title: '发布问题仍待复测',
          text: '已核对失败位置。还需要复测证据。',
          actions: [{ id: 'act', label: '补充复测结果' }],
          generatedUI,
        },
        status: 'accepted',
        receipt: 'saved',
        reason: null,
        attempt: 1,
      },
      {
        channel: 'weixin',
        presentation: { title: '发布核查', text: '仍待复测。', actions: [] },
        status: 'unknown',
        receipt: null,
        reason: '平台未返回完整回执',
        attempt: 1,
      },
      {
        channel: 'dingtalk',
        presentation: { title: '发布核查', text: '仍待复测。', actions: [] },
        status: 'accepted',
        receipt: 'card',
        reason: null,
        attempt: 1,
      },
      {
        channel: 'feishu',
        presentation: { title: '发布核查', text: '仍待复测。', actions: [] },
        status: 'rejected',
        receipt: null,
        reason: '当前不可投递',
        attempt: 1,
      },
    ],
  }
  await mockWorkspace(page, async () => ({ text: '请在原事项补充复测材料。' }))
  await page.route('**/api/listeners/router-publications', (route) =>
    route.fulfill({ json: [publication] }),
  )
  await page.route('**/api/listeners/router-publications/*/actions', (route) => {
    submissions.push(route.request().postDataJSON())
    return route.fulfill({ json: { message: '已交给 Router 继续处理。' } })
  })
  await page.goto('/router')
  const feed = page.getByRole('region', { name: 'Router 交付与各平台回执' })
  await expect(feed.getByText('发布问题仍待复测')).toBeVisible()
  await feed.getByText('查看各平台投递结果').click()
  await expect(feed).toContainText('微信：结果待核对')
  await expect(feed).toContainText('飞书：未发送')
  const generatedButton = feed.getByRole('button', { name: '补充复测结果' })
  await expect(generatedButton).toHaveCSS('border-top-style', 'solid')
  await expect(generatedButton).toHaveCSS('cursor', 'pointer')
  await generatedButton.focus()
  await expect(generatedButton).toBeFocused()
  await generatedButton.press('Enter')
  expect(submissions).toHaveLength(1)
  expect(submissions[0]).toMatchObject({ actionId: 'act', requestId: expect.any(String) })
  await expect(feed.getByText('已交给 Router 继续处理。')).toBeVisible()
  await page.getByRole('link', { name: /发布构建校验失败/ }).click()
  await expect(feed.getByText('发布问题仍待复测')).toBeVisible()
  await page.screenshot({
    path: '/private/tmp/zero-router-publication-desktop.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '/private/tmp/zero-router-publication-mobile.png', fullPage: true })
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
      .map((el) => ({
        tag: el.tagName,
        cls: el.className,
        right: el.getBoundingClientRect().right,
      }))
      .slice(0, 15),
  )
  expect(overflow).toEqual([])
  await page.screenshot({ path: '/private/tmp/zero-router-publication-mobile.png', fullPage: true })
})

test('a reader can submit a followup while the Router answers and see it after reload', async ({
  page,
}) => {
  await mockWorkspace(page, async () => ({ text: 'unexpected submission' }))
  const turns: RouterWorkspaceSnapshot['turns'] = [
    {
      id: 1,
      requestId: crypto.randomUUID(),
      question: '原问题',
      status: 'pending',
      answer: null,
      error: null,
      createdAt: item.receivedAt,
      updatedAt: item.receivedAt,
      surface: null,
    },
  ]
  const snapshot = (): RouterWorkspaceSnapshot => ({
    scope: 'general',
    event: null,
    route: null,
    settings: prefs,
    surface: buildRouterSurface('general', null, null, prefs.settings, []),
    turns,
  })
  await page.route('**/api/listeners/workspace/general', (route) =>
    route.fulfill({ json: snapshot() }),
  )
  await page.route('**/api/listeners/workspace/general/messages', (route) => {
    const { background, requestId, text } = route.request().postDataJSON()
    expect(background).toBe(true)
    turns.push({ ...turns[0], id: 2, requestId, question: text, status: 'queued' })
    return route.fulfill({ status: 202, json: snapshot() })
  })
  await page.goto('/router')
  await expect(page.getByText('原问题', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '给 Router 发消息' }).fill('请把时间改为35分钟')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('已排队，上一条处理结束后继续。')).toBeVisible()
  await page.reload()
  await expect(page.getByText('请把时间改为35分钟', { exact: true })).toBeVisible()
  await expect(page.getByText('已排队，上一条处理结束后继续。')).toBeVisible()
})

test('a failed answer opens its own trace and exposes the recorded tool error', async ({
  page,
}) => {
  const run = {
    id: 'failed-turn-trace',
    ordinal: 1,
    sessionId: 'router-general',
    label: 'Router 对话',
    matterId: null,
    status: 'failed',
    startedAt: item.receivedAt,
    endedAt: item.receivedAt,
    replayOf: null,
  }
  const snapshot: RouterWorkspaceSnapshot = {
    scope: 'general',
    event: null,
    route: null,
    settings: prefs,
    surface: buildRouterSurface('general', null, null, prefs.settings, []),
    turns: [
      {
        id: 32,
        requestId: 'fixture-failed',
        question: '核对原处的结果',
        status: 'failed',
        error: '没有完成核对',
        answer: null,
        createdAt: item.receivedAt,
        updatedAt: item.receivedAt,
        surface: null,
        traceRunIds: [run.id],
      },
    ],
  }
  await page.route('**/api/listeners/workspace/general', (route) =>
    route.fulfill({ json: snapshot }),
  )
  await page.route('**/api/listeners/router-traces**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(run.id)
        ? {
            run,
            nextAfter: null,
            entries: [
              {
                ordinal: 1,
                runId: run.id,
                kind: 'tool_result',
                createdAt: item.receivedAt,
                data: {
                  name: 'read_evidence',
                  id: 'failed-source',
                  result: { success: false, output: '原始记录访问失败' },
                },
              },
            ],
          }
        : { items: [run] },
    }),
  )
  await page.goto('/router')
  await page.getByRole('link', { name: '查看本轮轨迹' }).click()
  await expect(page).toHaveURL(new RegExp('selected=' + run.id))
  await page.getByText('工具返回', { exact: false }).first().click()
  await expect(page.getByText(/原始记录访问失败/)).toBeVisible()
})

const legacyView = process.env.ZERO_ACCEPTANCE_LEGACY_VIEW
if (legacyView) {
  test('an upgraded event opens its original conversation turns in order after reload', async ({
    page,
  }) => {
    const snapshot = JSON.parse(readFileSync(legacyView, 'utf8')) as RouterWorkspaceSnapshot
    const event = snapshot.event
    expect(event).not.toBeNull()
    await mockWorkspace(page, async () => ({ text: '当前视图只读' }))
    await page.route('**/api/listeners/workspace/' + event?.id, (route) =>
      route.fulfill({ json: snapshot }),
    )
    await page.goto('/router?event=' + event?.id)
    for (let i = 0; i < 2; i++) {
      const rows = page.locator('.rw-turn').filter({ hasText: /等待原件|已有旧收据|受限的旧资料/ })
      await expect(rows).toHaveCount(3)
      await expect(rows.nth(0)).toContainText('等待原件')
      await expect(rows.nth(1)).toContainText('已有旧收据')
      await expect(rows.nth(2)).toContainText('受限的旧资料')
      if (i === 0) await page.reload()
    }
  })
}

test('the trace return link restores the selected event, expanded prior attempt and reading position', async ({
  page,
}) => {
  const result: RouterTrackingResult = {
    ...issueResult(true),
    attempt: 2,
    traceRunId: 'worker-second',
    previous: { attempt: 1, status: 'completed', result: '首轮记录', traceRunId: 'worker-first' },
  }
  await mockWorkspace(page, async () => ({ text: '已收到补充资料' }), prefs, undefined, {
    event: trackedIssue,
    result: () => result,
  })
  const run = {
    id: 'worker-first',
    ordinal: 1,
    sessionId: 'router-job-' + result.id,
    label: 'Worker 首轮',
    matterId: null,
    status: 'completed',
    startedAt: item.receivedAt,
    endedAt: item.receivedAt,
    replayOf: null,
  }
  await page.route('**/api/listeners/router-traces**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(run.id)
        ? {
            run,
            nextAfter: null,
            entries: [
              {
                ordinal: 1,
                runId: run.id,
                kind: 'model_request',
                createdAt: run.startedAt,
                data: { request: { messages: ['本轮原始资料'] } },
              },
            ],
          }
        : { items: [run] },
    }),
  )
  await page.goto('/router?event=' + trackedIssue.id)
  await page
    .getByText(/上一次.*第 1 轮/)
    .first()
    .click()
  await page.getByRole('link', { name: '查看第 1 轮运行轨迹' }).click()
  await page.getByText('发送给模型的完整请求').click()
  await expect(page.getByText(/本轮原始资料/)).toBeVisible()
  await page.getByRole('link', { name: '返回原阅读位置' }).click()
  await expect(page.getByRole('link', { name: '查看第 1 轮运行轨迹' })).toBeFocused()
  await expect(page).toHaveURL(new RegExp('event=' + trackedIssue.id + '#rw-event-'))
})

test('a turn permalink reopens the original page after the recent window advances', async ({
  page,
}) => {
  await mockWorkspace(page, async () => ({ text: '正常回答' }))
  const turn = (id: number) => ({
    id,
    requestId: 'turn-' + id,
    status: 'completed' as const,
    attempt: 1,
    question: '提问 ' + id,
    answer: { text: '答复 ' + id },
    createdAt: item.receivedAt,
    updatedAt: item.receivedAt,
    error: null,
    surface: null,
  })
  const archiveRequests: number[] = []
  await page.route('**/api/listeners/workspace/general*', (route) => {
    const through = new URL(route.request().url()).searchParams.get('throughTurn')
    if (through) archiveRequests.push(Number(through))
    const data = {
      scope: 'general',
      event: null,
      route: null,
      settings: prefs,
      surface: buildRouterSurface('general', null, null, prefs.settings),
    }
    return route.fulfill({
      json: {
        ...data,
        ...(!through && { previousTurnId: 12 }),
        turns: through ? [turn(Number(through))] : [turn(80)],
      },
    })
  })
  await page.goto('/router')
  await page.getByRole('link', { name: '查看更早对话' }).click()
  await expect(page.locator('#rw-turn-12')).toBeFocused()
  await expect(page.locator('#rw-turn-12')).toContainText('答复 12')
  await expect(page.locator('#rw-turn-12 a[title="打开这条对话的固定链接"]')).toHaveAttribute(
    'href',
    /\#rw-turn-12$/,
  )
  await page.reload()
  await expect(page.locator('#rw-turn-12')).toBeFocused()
  await page.getByRole('link', { name: '返回最新对话' }).click()
  await expect(page.locator('#rw-turn-80')).toBeVisible()
  await expect(page.locator('#rw-turn-12')).toHaveCount(0)
  expect(archiveRequests).toContain(12)
})
