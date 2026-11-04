import type { BrowserContext, Page } from '@playwright/test'
import type { MandateTaskDetail } from '@zero-os/shared'
import { expect, test } from './fixtures'

const feed = '/api/listeners/web-notifications'
const createdAt = '2026-11-04T03:00:00.000Z'

function delivery(
  id: number,
  inboxId: number,
  taskId: number | null,
  destination: 'web' | 'weixin' = 'web',
) {
  return {
    destination,
    item: {
      id,
      inboxId,
      taskId,
      createdAt,
      title: `测试私密标题-${id}`,
      summary: `测试私密摘要-${id}`,
    },
  }
}

async function interceptFeed(page: Page | BrowserContext, existing: ReturnType<typeof delivery>[]) {
  const fixture = {
    deliveries: [...existing],
    latestRequests: 0,
    successfulPolls: 0,
    failedPolls: 0,
    failNextPoll: false,
  }
  await page.route('**/api/listeners/web-notifications**', async (route) => {
    const { pathname, searchParams } = new URL(route.request().url())
    const rows = fixture.deliveries
      .filter((row) => row.destination === 'web')
      .map((row) => row.item)
    const latestId = rows.at(-1)?.id ?? 0
    if (pathname === `${feed}/changes`) return route.fulfill({ status: 204 })
    if (pathname === `${feed}/latest`) {
      fixture.latestRequests++
      return route.fulfill({ json: { id: latestId } })
    }
    expect(pathname).toBe(feed)
    const after = searchParams.get('after')
    const before = searchParams.get('before')
    const limit = Number(searchParams.get('limit') ?? 50)
    if (after !== null) expect(searchParams.get('brief')).toBe('1')
    if (after !== null && fixture.failNextPoll) {
      fixture.failNextPoll = false
      fixture.failedPolls++
      return route.fulfill({ status: 503, json: { error: '临时断开' } })
    }
    if (after !== null) fixture.successfulPolls++
    const result =
      after !== null
        ? rows.filter((row) => row.id > Number(after))
        : rows.filter((row) => before === null || row.id < Number(before)).reverse()
    const items = result.slice(0, limit)
    return route.fulfill({
      json: {
        items:
          searchParams.get('brief') === '1'
            ? items.map(({ id, inboxId, taskId, createdAt }) => ({
                id,
                inboxId,
                taskId,
                createdAt,
              }))
            : items,
        latestId,
      },
    })
  })
  return fixture
}

test('announces only a new web delivery, recovers after a failed poll and opens the scoped task', async ({
  page,
}) => {
  const existing = delivery(5, 101, 8)
  const arrived = delivery(7, 61, 22)
  const feedState = await interceptFeed(page, [existing])
  const task: MandateTaskDetail = {
    id: 22,
    mandateId: 'private-watch',
    businessKey: 'run:61',
    title: arrived.item.title,
    latestInboxId: 61,
    eventCount: 1,
    active: true,
    paused: false,
    acknowledgedAt: null,
    sessionId: null,
    updatedAt: createdAt,
    matches: [
      {
        id: 12,
        taskId: 22,
        mandateId: 'private-watch',
        inboxId: 61,
        status: 'ready',
        summary: arrived.item.summary,
        error: null,
        effects: [],
      },
    ],
  }
  await page.route('**/api/listeners/mandates/tasks?*', (route) =>
    route.fulfill({ json: { items: [task] } }),
  )
  await page.route('**/api/listeners/mandates/tasks/22', (route) => route.fulfill({ json: task }))
  await page.clock.install()
  await page.goto('/memo')
  await expect.poll(() => feedState.latestRequests).toBeGreaterThan(0)
  const notice = page.getByRole('complementary', { name: '网页提醒' })
  await expect(notice).not.toBeVisible()

  feedState.deliveries.push(delivery(6, 120, 70, 'weixin'))
  await page.clock.fastForward(31_000)
  await expect.poll(() => feedState.latestRequests + feedState.successfulPolls).toBeGreaterThan(1)
  await expect(notice).not.toBeVisible()

  feedState.failNextPoll = true
  feedState.deliveries.push(arrived)
  await page.clock.fastForward(31_000)
  await expect.poll(() => feedState.failedPolls).toBe(1)
  await expect(notice).not.toBeVisible()
  await page.clock.fastForward(31_000)
  const open = notice.getByRole('link', { name: '打开任务 #22' })
  await expect(open).toHaveAttribute('href', '/router?task=22')
  await expect(page.locator('body')).not.toContainText(arrived.item.title)
  await expect(page.locator('body')).not.toContainText(arrived.item.summary)
  await open.click()
  await expect(page).toHaveURL(/\/router\?task=22$/)
  await expect(page.getByRole('region', { name: '任务时间线' })).toContainText(arrived.item.summary)
  await expect(notice).not.toBeVisible()
  await page.reload()
  await page.clock.fastForward(31_000)
  await expect(notice).not.toBeVisible()
})

test('groups accumulated legacy and task deliveries into a navigable local history', async ({
  page,
}) => {
  const existing = delivery(18, 105, null)
  const arrived = [delivery(19, 44, null), delivery(20, 28, 10), delivery(21, 44, 11)]
  const feedState = await interceptFeed(page, [existing])
  await page.clock.install()
  await page.goto('/memo')
  await expect.poll(() => feedState.latestRequests).toBeGreaterThan(0)
  const notice = page.getByRole('complementary', { name: '网页提醒' })
  await expect(notice).not.toBeVisible()
  feedState.deliveries.push(...arrived)
  await page.clock.fastForward(31_000)
  const all = notice.getByRole('link', { name: '查看全部网页提醒' })
  await expect(all).toHaveAttribute('href', '/router?view=notifications')
  for (const row of arrived) {
    await expect(notice).not.toContainText(row.item.title)
    await expect(notice).not.toContainText(row.item.summary)
  }
  await all.click()
  const history = page.getByRole('region', { name: '网页提醒记录' })
  await expect(history).toBeVisible()
  for (const row of [existing, ...arrived]) {
    const url =
      row.item.taskId === null
        ? `/router?event=${row.item.inboxId}`
        : `/router?task=${row.item.taskId}`
    await expect(history.locator(`a[href="${url}"]`)).toBeVisible()
  }
  await page.reload()
  await expect(history.locator('a[href="/router?task=11"]')).toBeVisible()
  await page.clock.fastForward(31_000)
  await expect(notice).not.toBeVisible()
})

test('a live change signal opens a new task reminder before the next polling interval', async ({
  page,
}) => {
  const feedState = await interceptFeed(page, [delivery(2, 14, null)])
  const releaseChange = Promise.withResolvers<void>()
  let connected = false
  await page.route(`**${feed}/changes`, async (route) => {
    connected = true
    await releaseChange.promise
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache' },
      body: 'retry: 60000\ndata: changed\n\n',
    })
  })
  const notice = page.getByRole('complementary', { name: '网页提醒' })
  try {
    await page.goto('/memo')
    await expect.poll(() => connected && feedState.latestRequests > 0).toBe(true)
    await expect(notice).not.toBeVisible()
    feedState.deliveries.push(delivery(3, 11, 52))
  } finally {
    releaseChange.resolve()
  }
  await expect(notice.getByRole('link', { name: '打开任务 #52' })).toBeVisible({ timeout: 5000 })
  expect(feedState.successfulPolls).toBe(1)
})

test('remembers the browser delivery cursor when the tab closes, and restarts it when the database is replaced', async ({
  page,
  context,
}) => {
  const key = 'zero-web-notifications-v2-cursor'
  const savedCursor = (tab: Page) => tab.evaluate((name) => localStorage.getItem(name), key)
  const feedState = await interceptFeed(context, [delivery(71, 101, null)])
  await page.goto('/memo')
  await expect.poll(() => savedCursor(page)).toBe('71')
  await expect(page.getByRole('complementary', { name: '网页提醒' })).not.toBeVisible()
  await page.close()
  feedState.deliveries.push(delivery(72, 61, 9))

  const returned = await context.newPage()
  await returned.goto('/memo')
  const notice = returned.getByRole('complementary', { name: '网页提醒' })
  await expect(notice.getByRole('link', { name: '打开任务 #9' })).toBeVisible()
  await expect.poll(() => savedCursor(returned)).toBe('72')
  const prior = feedState.latestRequests
  await returned.reload()
  await expect.poll(() => feedState.latestRequests).toBeGreaterThan(prior)
  await expect(notice).not.toBeVisible()

  const reconnect = () => returned.evaluate(() => window.dispatchEvent(new Event('online')))
  feedState.deliveries.push(delivery(73, 62, 10))
  await reconnect()
  await expect(notice.getByRole('link', { name: '打开任务 #10' })).toBeVisible()
  feedState.deliveries = [delivery(1, 210, 30)]
  await reconnect()
  await expect.poll(() => savedCursor(returned)).toBe('1')
  await expect(notice).not.toBeVisible()
  feedState.deliveries.push(delivery(2, 211, 31))
  await reconnect()
  await expect(notice.getByRole('link', { name: '打开任务 #31' })).toBeVisible()
  await expect.poll(() => savedCursor(returned)).toBe('2')
})

test('keeps the page notification cursor in memory when browser storage is unavailable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage is disabled', 'SecurityError')
      },
    })
  })
  const feedState = await interceptFeed(page, [delivery(1, 4, null)])
  await page.clock.install()
  await page.goto('/memo')
  await expect.poll(() => feedState.latestRequests).toBeGreaterThan(0)
  const notice = page.getByRole('complementary', { name: '网页提醒' })
  await expect(notice).not.toBeVisible()
  feedState.deliveries.push(delivery(2, 7, 41))
  await page.clock.fastForward(31_000)
  await expect(notice.getByRole('link', { name: '打开任务 #41' })).toBeVisible()
  await notice.getByRole('button', { name: '关闭网页提醒' }).click()
  const prior = feedState.latestRequests
  await page.clock.fastForward(31_000)
  await expect.poll(() => feedState.latestRequests).toBeGreaterThan(prior)
  await expect(notice).not.toBeVisible()
  expect(feedState.successfulPolls).toBe(1)
})
