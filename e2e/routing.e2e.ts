import type {
  TriggerInboxItem,
  TriggerRouteRecord,
  TriggerRoutingSettingsSnapshot,
} from '@zero-os/shared'
import { expect, test } from './fixtures'

test.use({ timezoneId: 'Asia/Shanghai' })

const raw: TriggerInboxItem = {
  id: 27,
  source: 'github',
  eventId: 'acme/api:51:1:failure',
  scope: 'acme/api',
  title: '发布检查失败',
  summary: 'CI job migration-check exited with status 1.',
  occurredAt: '2026-11-03T02:30:00.000Z',
  receivedAt: '2026-11-03T02:31:00.000Z',
  url: 'https://github.com/acme/api/actions/runs/51',
}
const processed = {
  inboxId: raw.id,
  origin: 'manual',
  status: 'web',
  sessionId: 'session-test',
  agent: { summary: '迁移检查未通过，需要检查发布清单。' },
  decision: { destination: 'web', reason: '工作时段且网页在场。' },
  firstDeferred: { at: raw.receivedAt, reason: '用户当时已离开，稍后复查。' },
  error: null,
  settingsRevision: 1,
  weixinTarget: null,
  updatedAt: '2026-11-03T02:32:00.000Z',
} satisfies TriggerRouteRecord

const initial: TriggerRoutingSettingsSnapshot = {
  revision: 1,
  settings: {
    enabled: false,
    timeZone: 'Asia/Shanghai',
    workdays: [1, 2, 3, 4, 5],
    workStart: '09:00',
    workEnd: '18:00',
    presence: 'auto',
    awayFallback: 'defer',
    duringWork: 'web',
    afterWork: 'defer',
    offDay: 'defer',
    weixinTarget: null,
  },
}

test('selects a WeChat bot, saves routing preferences and keeps the agent result separate from the event', async ({
  page,
}) => {
  const bot = {
    platform: 'weixin',
    channelId: 'test-channel',
    label: '个人微信',
    online: true,
    ready: true,
    deliveryState: 'ready',
  }
  let saved = structuredClone(initial)
  let targetRequests = 0
  let processedId: number | null = null
  await page.route('**/api/listeners/inbox?*', (route) => route.fulfill({ json: { items: [raw] } }))
  await page.route('**/api/listeners/routing/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    switch (path) {
      case '/api/listeners/routing/preferences':
        if (request.method() === 'PUT') {
          const submitted = request.postDataJSON() as TriggerRoutingSettingsSnapshot
          expect(submitted.revision).toBe(saved.revision)
          saved = { revision: submitted.revision + 1, settings: submitted.settings }
        }
        return route.fulfill({ json: saved })
      case '/api/listeners/routing/bots':
        return route.fulfill({ json: { bots: [bot] } })
      case '/api/listeners/routing/targets':
        targetRequests++
        return route.fulfill({ json: { targets: [] } })
      case '/api/listeners/routing/presence':
        return route.fulfill({ json: { ok: true } })
      case '/api/listeners/routing/process':
        expect(request.method()).toBe('POST')
        expect(request.postDataJSON()).toEqual({ inboxId: raw.id })
        processedId = raw.id
        return route.fulfill({ json: { accepted: true } })
      case '/api/listeners/routing/records':
      case '/api/listeners/routing/web':
        return route.fulfill({
          json: { records: processedId === null ? [] : [{ event: raw, route: processed }] },
        })
      case '/api/listeners/routing/web/latest':
        return route.fulfill({ json: { latestId: processedId } })
      default:
        throw new Error(`Unexpected routing request: ${path}`)
    }
  })

  await page.goto('/config?tab=listeners')
  const prefs = page.getByRole('region', { name: 'Agent 与通知路由' })
  const enable = prefs.getByRole('checkbox', { name: '启用 Agent 与通知路由' })
  const save = prefs.getByRole('button', { name: '保存路由设置' })
  await expect(enable).not.toBeChecked()
  await enable.check()
  await prefs.getByRole('combobox', { name: '工作时段', exact: true }).selectOption('web')
  await prefs.getByRole('combobox', { name: '下班时段', exact: true }).selectOption('weixin')
  await prefs.getByRole('combobox', { name: '休息日', exact: true }).selectOption('defer')
  await save.click()
  await expect.poll(() => saved.revision).toBe(2)
  await expect(prefs.getByText('已保存路由设置', { exact: true })).toBeVisible()
  expect(saved.settings.weixinTarget).toBeNull()
  expect(targetRequests).toBe(0)
  await prefs.getByRole('combobox', { name: '微信机器人', exact: true }).selectOption(bot.channelId)
  await save.click()
  await expect.poll(() => saved.revision).toBe(3)
  expect(saved.settings).toMatchObject({
    enabled: true,
    duringWork: 'web',
    afterWork: 'weixin',
    offDay: 'defer',
    personalBots: { weixin: bot.channelId },
  })

  await page.reload()
  await expect(enable).toBeChecked()
  await expect(prefs.getByRole('combobox', { name: '下班时段', exact: true })).toHaveValue('weixin')
  const preview = prefs
    .locator('details')
    .filter({ has: page.getByText('情境预演', { exact: true }) })
  await preview.locator('summary').click()
  await preview.getByLabel(/模拟时间/).fill('2026-11-03T10:30')
  await preview.getByRole('combobox', { name: '模拟在场状态' }).selectOption('present')
  await expect(preview.getByRole('status')).toContainText('网页展示')
  await preview.getByRole('combobox', { name: '模拟在场状态' }).selectOption('away')
  await expect(preview.getByRole('status')).toContainText('延后提醒')
  await preview.getByLabel(/模拟时间/).fill('2026-11-03T19:30')
  await expect(preview.getByRole('status')).toContainText('发送微信')
  await preview.getByRole('combobox', { name: '模拟微信机器人' }).selectOption('unavailable')
  await expect(preview.getByRole('status')).toContainText('延后提醒')
  await prefs.getByRole('combobox', { name: '进展通知方式' }).selectOption('contextual')
  await prefs.getByRole('combobox', { name: '紧急提醒首选' }).selectOption('weixin')
  await save.click()
  await expect.poll(() => saved.settings.urgentDestination).toBe('weixin')
  await preview.getByLabel(/模拟时间/).fill('2026-11-08T10:30')
  await preview.getByRole('combobox', { name: '模拟微信机器人' }).selectOption('online')
  await expect(preview.getByRole('status')).toContainText('延后提醒')
  await preview.getByLabel('模拟紧急程度').selectOption('urgent')
  await expect(preview.getByRole('status')).toContainText('发送微信')
  await expect(preview.getByRole('status')).toContainText('紧急提醒')
  expect(processedId).toBeNull()
  const inbox = page.getByRole('region', { name: '原始事件收件箱' })
  await inbox.locator('summary').filter({ hasText: raw.title }).click()
  await expect(inbox.getByText(raw.summary, { exact: true })).toBeVisible()
  await inbox.getByRole('button', { name: '分析并路由通知' }).click()
  await expect(inbox.getByRole('link', { name: '打开事件对话', exact: true })).toHaveAttribute(
    'href',
    `/router?event=${raw.id}`,
  )
  const web = page.getByRole('region', { name: '网页通知' })
  await expect(web.getByRole('article')).toContainText(processed.agent.summary)
  await expect(inbox).not.toContainText(processed.agent.summary)
  const history = page.getByRole('region', { name: '路由记录' })
  await expect(history).toContainText(raw.title)
  await expect(history).toContainText(processed.decision.reason)
  await expect(history).toContainText(processed.firstDeferred.reason)
  expect(targetRequests).toBe(0)
})

test('allows a second explicit retry after a fast failure and removes retry after delivery', async ({
  page,
}) => {
  const target = { channelId: 'test-channel', peerId: 'test-peer' }
  let record: TriggerRouteRecord = {
    ...processed,
    status: 'failed',
    firstDeferred: null,
    decision: { destination: 'weixin', reason: '下班时段使用已绑定的微信。' },
    weixinTarget: target,
    error: '首次处理失败',
  }
  let attempts = 0
  await page.route('**/api/listeners/routing/preferences', (route) =>
    route.fulfill({
      json: {
        revision: 1,
        settings: {
          ...initial.settings,
          enabled: true,
          afterWork: 'weixin',
          personalBots: { weixin: target.channelId },
          weixinTarget: null,
        },
      },
    }),
  )
  await page.route('**/api/listeners/routing/records?*', (route) =>
    route.fulfill({ json: { records: [{ event: raw, route: record }] } }),
  )
  await page.route('**/api/listeners/routing/process', (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({ inboxId: raw.id })
    attempts++
    record =
      attempts === 1
        ? { ...record, status: 'failed', error: '重试后立即失败' }
        : { ...record, status: 'sent', error: null }
    return route.fulfill({ json: { accepted: true } })
  })

  await page.goto('/config?tab=listeners#routing-records')
  const history = page.getByRole('region', { name: '路由记录' })
  const entry = history.getByRole('article').filter({ hasText: raw.title })
  const retry = entry.getByRole('button', { name: '重试通知路由' })
  await expect(entry).toContainText('首次处理失败')
  expect(attempts).toBe(0)
  await retry.click()
  await expect(entry).toContainText('重试后立即失败')
  await expect(retry).toBeEnabled()
  expect(attempts).toBe(1)
  await retry.click()
  await expect(entry).toContainText('微信平台已受理')
  await expect(retry).toHaveCount(0)
  await Promise.all([
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/listeners/routing/records',
    ),
    history.getByRole('button', { name: '刷新路由记录' }).click(),
  ])
  expect(attempts).toBe(2)
})

test('routes with only a bot selection and distinguishes replies from proactive reminders', async ({
  page,
}) => {
  const bots = [
    { platform: 'dingtalk', channelId: 'ops', label: '运维机器人', deliveryState: 'ready' },
    { platform: 'dingtalk', channelId: 'project', label: '项目机器人', deliveryState: 'ambiguous' },
    { platform: 'dingtalk', channelId: 'paused', label: '离线机器人', deliveryState: 'offline' },
    {
      platform: 'feishu',
      channelId: 'lab',
      label: '研究机器人',
      deliveryState: 'awaiting_private',
    },
    { platform: 'weixin', channelId: 'home', label: '个人微信', deliveryState: 'unavailable' },
  ]
  let saved: TriggerRoutingSettingsSnapshot = {
    revision: 8,
    settings: {
      ...initial.settings,
      enabled: true,
      personalBots: { weixin: 'home' },
    },
  }
  const unexpectedRequests: string[] = []
  await page.route(
    /\/api\/listeners\/(?:channels\/(?:personal-targets|bot-bindings)|routing\/(?:config|personal-targets|targets))$/,
    (route) => {
      unexpectedRequests.push(route.request().url())
      return route.fulfill({ status: 404 })
    },
  )
  await page.route('**/api/listeners/routing/bots', (route) =>
    route.fulfill({
      json: {
        bots: bots.map((bot) => ({
          ...bot,
          online: bot.deliveryState !== 'offline',
          ready: bot.deliveryState === 'ready',
        })),
      },
    }),
  )
  await page.route('**/api/listeners/routing/preferences', (route) => {
    const request = route.request()
    if (request.method() === 'PUT') {
      const submitted = request.postDataJSON() as TriggerRoutingSettingsSnapshot
      expect(submitted.revision).toBe(saved.revision)
      saved = { revision: submitted.revision + 1, settings: submitted.settings }
    }
    return route.fulfill({ json: saved })
  })

  await page.goto('/config?tab=channels')
  await expect(page.getByRole('link', { name: '选择 Router 使用的通知机器人' })).toBeVisible()
  await expect(page.getByRole('region', { name: '机器人默认接收会话' })).toHaveCount(0)

  await page.goto('/router')
  await page.getByRole('button', { name: '通知渠道与路由设置' }).click()
  const prefs = page.getByRole('region', { name: 'Agent 与通知路由' })
  const dingPicker = prefs.getByRole('combobox', { name: '钉钉机器人', exact: true })
  const fsPicker = prefs.getByRole('combobox', { name: '飞书机器人', exact: true })
  await expect(prefs.getByText(/原来的普通 Agent 会话会解绑，历史记录保留/)).toBeVisible()
  await expect(dingPicker.getByRole('option', { name: '项目机器人 · 在线' })).toHaveCount(1)
  await dingPicker.selectOption('project')
  await expect(prefs.getByText(/有多位私聊联系人，Router 无法确认本人/)).toBeVisible()
  await dingPicker.selectOption('paused')
  await expect(prefs.getByText(/机器人离线，主动提醒将延后/)).toBeVisible()
  await dingPicker.selectOption('ops')
  await expect(prefs.getByText('可在本人私聊中与 Router 对话和接收主动提醒。')).toBeVisible()
  await fsPicker.selectOption('lab')
  await expect(prefs.getByText(/先私聊这个机器人发一条消息/)).toBeVisible()
  await expect(prefs.getByText(/原有的个人私聊当前不可用/)).toBeVisible()
  await expect(prefs).not.toContainText('投递待配置')
  await expect(prefs.getByRole('combobox', { name: /接收会话/ })).toHaveCount(0)
  await prefs.getByRole('combobox', { name: '网页无人时', exact: true }).selectOption('dingtalk')
  await prefs.getByRole('combobox', { name: '下班时段', exact: true }).selectOption('feishu')
  await prefs.getByRole('button', { name: '保存路由设置' }).click()
  await expect.poll(() => saved.revision).toBe(9)
  expect(saved.settings.personalBots).toEqual({ weixin: 'home', dingtalk: 'ops', feishu: 'lab' })
  expect(saved.settings.weixinTarget).toBeNull()

  await page.goto('/config?tab=listeners')
  await expect(dingPicker).toHaveValue('ops')
  await expect(fsPicker).toHaveValue('lab')
  const preview = prefs
    .locator('details')
    .filter({ has: page.getByText('情境预演', { exact: true }) })
  await preview.locator('summary').click()
  await preview.getByLabel(/模拟时间/).fill('2026-11-03T10:30')
  await preview.getByRole('combobox', { name: '模拟在场状态' }).selectOption('away')
  await preview.getByRole('combobox', { name: '模拟飞书机器人' }).selectOption('unavailable')
  await expect(preview.getByRole('status').locator('strong')).toHaveText('发送钉钉')
  await preview.getByLabel(/模拟时间/).fill('2026-11-03T19:30')
  await expect(preview.getByRole('status').locator('strong')).toHaveText('延后提醒')
  await preview.getByRole('combobox', { name: '模拟飞书机器人' }).selectOption('online')
  await expect(preview.getByRole('status').locator('strong')).toHaveText('发送飞书')
  await fsPicker.selectOption('')
  await prefs.getByRole('button', { name: '保存路由设置' }).click()
  await expect.poll(() => saved.revision).toBe(10)
  expect(saved.settings.personalBots).toEqual({ weixin: 'home', dingtalk: 'ops', feishu: null })
  await expect(preview.getByRole('status').locator('strong')).toHaveText('延后提醒')
  expect(unexpectedRequests).toEqual([])
})

test('updates presence on trusted interaction and announces only new web deliveries', async ({
  page,
}) => {
  let latestId = 5
  let checks = 0
  let heartbeats = 0
  await page.route('**/api/listeners/web-notifications/latest', (route) => {
    checks++
    return route.fulfill({ json: { id: latestId } })
  })
  await page.route('**/api/listeners/web-notifications?*', (route) =>
    route.fulfill({
      json: {
        items: [{ id: latestId, taskId: null, inboxId: 41, createdAt: '2026-11-04T02:00:00Z' }],
        latestId,
      },
    }),
  )
  await page.route('**/api/listeners/routing/presence', (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({})
    heartbeats++
    return route.fulfill({ json: { ok: true } })
  })
  await page.clock.install()
  await page.goto('/config')
  await expect.poll(() => checks).toBeGreaterThan(0)
  await page.clock.fastForward(21_000)
  const notice = page.getByRole('complementary', { name: '网页提醒' })
  await expect(notice).not.toBeVisible()
  const initialHeartbeats = heartbeats
  const initialChecks = checks
  await page.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  })
  await page.clock.fastForward(31_000)
  await expect.poll(() => checks).toBeGreaterThan(initialChecks)
  expect(heartbeats).toBe(initialHeartbeats)

  await page.keyboard.press('Tab')
  await expect.poll(() => heartbeats).toBe(initialHeartbeats + 1)
  latestId++
  await page.clock.fastForward(31_000)
  const notification = notice.getByRole('link', { name: '查看网页通知' })
  await expect(notification).toBeVisible()
  await notification.click()
  await expect(page).toHaveURL(/\/config\?tab=listeners#routing-web$/)
  await expect(page.getByRole('region', { name: '网页通知' })).toBeVisible()
})

test('saves local calendar exceptions and previews a locked Mac without reading the host', async ({
  page,
}) => {
  let saved = structuredClone(initial)
  await page.route('**/api/listeners/routing/preferences', async (route) => {
    if (route.request().method() === 'PUT') {
      const submitted = route.request().postDataJSON() as TriggerRoutingSettingsSnapshot
      saved = { revision: submitted.revision + 1, settings: submitted.settings }
    }
    await route.fulfill({ json: saved })
  })
  await page.goto('/config?tab=listeners')
  const prefs = page.getByRole('region', { name: 'Agent 与通知路由' })
  await prefs.getByText('假日与补班', { exact: true }).click()
  await prefs.getByLabel('例外日期').fill('2026-11-07')
  await prefs.getByLabel('当天安排').selectOption('work')
  await prefs.getByRole('button', { name: '加入日历' }).click()
  await prefs.getByText('Mac 在场信号', { exact: true }).click()
  await prefs.getByLabel('判断网页在场时检查 Mac 锁屏和空闲状态').check()
  await prefs.getByRole('button', { name: '保存路由设置' }).click()
  await expect.poll(() => saved.settings.dateOverrides).toEqual({ '2026-11-07': 'work' })
  expect(saved.settings.nativePresence).toEqual({ enabled: true, bluetooth: false, idleMinutes: 5 })
  await page.reload()
  await prefs.getByText('情境预演', { exact: true }).click()
  await prefs.getByLabel('模拟时间', { exact: false }).fill('2026-11-07T12:00')
  const preview = prefs
    .locator('details')
    .filter({ has: page.getByText('情境预演', { exact: true }) })
  await expect(preview.locator('output')).toContainText('网页展示')
  await expect(preview.locator('output')).toContainText('日历指定上班')
  await prefs.getByLabel('模拟 Mac 状态').selectOption('locked')
  await expect(preview.locator('output')).toContainText('延后提醒')
  await expect(preview.locator('output')).toContainText('已锁屏')
})
