import { readFileSync } from 'node:fs'
import type { RouterTraceEntry, RouterTraceRun } from '@zero-os/shared'
import { expect, test } from './fixtures'

test('Router trace browser shows actual inputs, preserves prose and offers isolated replay', async ({
  page,
}) => {
  const run = {
    id: 'trace-fixture',
    ordinal: 1,
    sessionId: 'router-owner',
    label: 'Router 对话',
    matterId: 'matter-fixture',
    status: 'completed',
    startedAt: '2026-11-05T01:00:00Z',
    endedAt: '2026-11-05T01:00:10Z',
    replayOf: null,
  }
  await page.route('**/api/listeners/router-traces**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/replay'))
      return route.fulfill({
        json: {
          text: '仍需复测；本轮没有执行真实工具。',
          run: { ...run, id: 'replay-fixture', replayOf: run.id },
        },
      })
    if (url.pathname.endsWith('/trace-fixture'))
      return route.fulfill({
        json: {
          run,
          nextAfter: null,
          entries: [
            {
              ordinal: 0,
              runId: run.id,
              kind: 'input',
              createdAt: run.startedAt,
              data: { prompt: '按此前记录查询 PR' },
            },
            {
              ordinal: 1,
              runId: run.id,
              kind: 'model_request',
              createdAt: run.startedAt,
              data: { request: { messages: [{ text: '刚才查过的项目，还有哪些未关闭 PR？' }] } },
            },
            {
              ordinal: 2,
              runId: run.id,
              kind: 'tool_result',
              createdAt: run.startedAt,
              data: { id: 'receipt-1', result: { output: '完整清册原文 Q7' } },
            },
            {
              ordinal: 3,
              runId: run.id,
              kind: 'model_request',
              createdAt: run.startedAt,
              data: {
                projection: { originals: ['receipt-1'] },
                request: { messages: [{ text: '仅含回执索引' }] },
              },
            },
            {
              ordinal: 4,
              runId: run.id,
              kind: 'result',
              createdAt: run.endedAt,
              data: { text: '已核对当前状态，仍有 2 项等待复测。' },
            },
          ],
        },
      })
    if (url.pathname.endsWith('/replay-fixture'))
      return route.fulfill({
        json: {
          run: { ...run, id: 'replay-fixture', replayOf: run.id },
          nextAfter: null,
          entries: [
            {
              ordinal: 1,
              runId: 'replay-fixture',
              kind: 'input',
              createdAt: run.startedAt,
              data: { prompt: '加入今天的复测记录后查询 PR' },
            },
            {
              ordinal: 2,
              runId: 'replay-fixture',
              kind: 'replay_tool',
              createdAt: run.startedAt,
              data: {
                name: 'query',
                sourceRunId: run.id,
                sourceEntryOrdinal: 7,
                mode: 'recorded-result',
              },
            },
          ],
        },
      })
    return route.fulfill({ json: { items: [run] } })
  })
  await page.goto('/router/traces')
  await expect(page.getByRole('heading', { name: 'Router 处理轨迹' })).toBeVisible()
  await page.getByRole('button', { name: /Router 对话/ }).click()
  await page.getByText('发送给模型的完整请求').first().click()
  await expect(
    page
      .locator('#trace-entry-1')
      .getByText('刚才查过的项目，还有哪些未关闭 PR？', { exact: false }),
  ).toBeVisible()
  await expect(
    page.getByText('已核对当前状态，仍有 2 项等待复测。', { exact: false }),
  ).toBeVisible()
  await page.getByText('发送给模型的完整请求').last().click()
  await page.getByRole('button', { name: '查看原回执 #2' }).click()
  await expect(page.getByText(/完整清册原文 Q7/)).toBeVisible()
  await page.getByRole('button', { name: '用已记录回执重放' }).click()
  await expect(page.getByText('仍需复测；本轮没有执行真实工具。')).toBeVisible()
  await page.getByRole('link', { name: '查看本次重放轨迹' }).click()
  await page.getByText('对比原运行与重放的输入').click()
  await expect(page.getByText('按此前记录查询 PR', { exact: true })).toBeVisible()
  await expect(page.getByText('加入今天的复测记录后查询 PR', { exact: true })).toBeVisible()
  await expect(page.getByText(/使用原记录 #7/)).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '/private/tmp/zero-router-trace-mobile.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.screenshot({ path: '/private/tmp/zero-router-trace-mobile.png', fullPage: true })
})

test('a matter opens its Worker run and the return link selects that same matter', async ({
  page,
}) => {
  const matterId = 'matter-native'
  const runId = 'worker-fixture'
  const run = {
    id: runId,
    ordinal: 1,
    label: 'Codex Worker 办理',
    sessionId: 'router-job-7',
    matterId,
    status: 'completed',
    startedAt: '2026-11-06T01:10:00Z',
    endedAt: '2026-11-06T01:11:00Z',
    replayOf: null,
  }
  await page.route('**/api/listeners/router-matters*', (route) =>
    route.fulfill({
      json: [
        {
          id: matterId,
          title: '归档编号核对',
          goal: '核对档案编号',
          criteria: ['核对原文'],
          state: 'completed',
          version: 2,
          context: {},
          updatedAt: run.endedAt,
          workerSessions: [{ jobId: 7, latestRunId: runId, handoffFromJobId: 4 }],
          sources: [{ id: 7, title: '档案签收单' }],
          corrections: [{ eventId: 3, reason: '另一个档案的进展', recordedAt: run.endedAt }],
        },
      ],
    }),
  )
  await page.route('**/api/listeners/router-traces**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(`/${runId}`)
        ? {
            run,
            nextAfter: null,
            entries: [
              {
                ordinal: 1,
                kind: 'input',
                runId,
                createdAt: run.startedAt,
                data: { transport: 'codex-app-server' },
              },
              {
                ordinal: 2,
                kind: 'worker_request',
                runId,
                createdAt: run.startedAt,
                data: { method: 'turn/start', data: { input: [{ text: '核对归档文件' }] } },
              },
              {
                ordinal: 3,
                kind: 'worker_event',
                runId,
                createdAt: run.endedAt,
                data: {
                  method: 'item/completed',
                  data: {
                    type: 'commandExecution',
                    command: 'cat evidence.txt',
                    exitCode: 0,
                    aggregatedOutput: '档案编号 W73',
                  },
                },
              },
            ],
          }
        : { items: [run] },
    }),
  )
  await page.goto(`/router?view=tasks&matterId=${matterId}`)
  await page.getByText('关联事件（1）').click()
  await expect(page.getByRole('link', { name: '事件 #7 · 档案签收单' })).toHaveAttribute(
    'href',
    '/router?event=7',
  )
  await page.getByText('查看历史纠正').click()
  await expect(page.getByText(/移出事件 #3 · 另一个档案的进展/)).toBeVisible()
  await expect(page.getByText(/接手自 Worker #4/)).toBeVisible()
  await page.getByRole('link', { name: '查看 Worker #7 的工作轨迹' }).click()
  await expect(page.getByRole('heading', { name: run.label })).toBeVisible()
  await page.getByText('发送给 Codex 的请求').click()
  await expect(page.getByText(/核对归档文件/)).toBeVisible()
  await page.getByText('命令结果 · 退出码 0').click()
  await expect(page.getByText(/档案编号 W73/)).toBeVisible()
  await expect(page.getByRole('button', { name: '用已记录回执重放' })).toHaveCount(0)
  await page.getByRole('link', { name: '返回这件跟进事项' }).click()
  await expect(page).toHaveURL(/matterId=matter-native/)
  await expect(page.getByText('归档编号核对', { exact: true })).toBeVisible()
})

test('a session link filters the first request and a denied search is distinct from an empty result', async ({
  page,
}) => {
  let sessionId: string | null = null
  await page.route('**/api/listeners/router-traces?**', (route) => {
    sessionId = new URL(route.request().url()).searchParams.get('sessionId')
    return route.fulfill({ status: 403, json: { error: '仅允许来自本机 ZeRo 页面的请求。' } })
  })
  await page.goto('/router/traces?sessionId=router-event-42')
  await expect(page.getByLabel('会话标识')).toHaveValue('router-event-42')
  await expect(page.getByRole('alert').filter({ hasText: '查询失败' })).toBeVisible()
  expect(sessionId).toBe('router-event-42')
  await expect(page.getByText('没有找到符合当前筛选条件的轨迹。')).toHaveCount(0)
})

test('an expired event explanation is distinct from the empty search and keeps stored runs accessible', async ({
  page,
}) => {
  await page.route('**/api/listeners/router-traces?**', (route) => {
    const isExpired = new URL(route.request().url()).searchParams.get('eventId') === '24'
    return route.fulfill({ json: { items: [], ...(isExpired && { expiredSources: ['event'] }) } })
  })
  await page.goto('/router/traces')
  await page.getByText('更多筛选').click()
  await page.getByLabel('事件编号').fill('24')
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await expect(
    page.getByText('原事件的正文已过保留期。这里仍可查询已保存的运行轨迹。'),
  ).toBeVisible()
  await page.getByLabel('事件编号').fill('25')
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await expect(
    page.getByText('原事件的正文已过保留期。这里仍可查询已保存的运行轨迹。'),
  ).toHaveCount(0)
  await expect(page.getByText('没有找到符合当前筛选条件的轨迹。')).toBeVisible()
})

test('the tool call filter sends the exact call identifier to the read-only API', async ({
  page,
}) => {
  await page.route('**/api/listeners/router-traces?**', (route) =>
    route.fulfill({ json: { items: [] } }),
  )
  await page.goto('/router/traces')
  await page.getByText('更多筛选').click()
  await page.getByLabel('工具调用标识').fill('call-source-17')
  const requested = page.waitForRequest(
    (req) => new URL(req.url()).searchParams.get('toolCallId') === 'call-source-17',
  )
  await page.getByRole('button', { name: '查询', exact: true }).click()
  expect((await requested).method()).toBe('GET')
})

const recordedTrace = process.env.ZERO_ACCEPTANCE_BROWSER_TRACE
if (recordedTrace) {
  test('opens the exact inputs and originals from the real model capacity and revocation run', async ({
    page,
  }) => {
    const data = JSON.parse(readFileSync(recordedTrace, 'utf8')) as {
      run: RouterTraceRun
      entries: RouterTraceEntry[]
    }
    await page.route('**/api/listeners/router-traces**', (route) =>
      route.fulfill({
        json: new URL(route.request().url()).pathname.endsWith(data.run.id)
          ? data
          : { items: [data.run] },
      }),
    )
    await page.goto('/router/traces?selected=' + data.run.id)
    const historyRequest = data.entries.find(
      (entry) =>
        entry.kind === 'model_request' &&
        (entry.data as { projection?: { historyMessages?: string[] } }).projection?.historyMessages
          ?.length,
    )!
    const receiptRequest = data.entries.find(
      (entry) =>
        entry.kind === 'model_request' &&
        (entry.data as { projection?: { originals?: string[] } }).projection?.originals?.length,
    )!
    const history = page.locator(`#trace-entry-${historyRequest.ordinal}`)
    await history.locator('summary').click()
    await expect(history.locator('pre')).not.toContainText('无关排版校样第 4000 行')
    await history.getByRole('button', { name: /查看折叠前的对话/ }).click()
    const initial = data.entries.find((entry) => entry.kind === 'input')!
    await expect(page.locator(`#trace-entry-${initial.ordinal} pre`)).toContainText(
      '无关排版校样第 4000 行',
    )
    const receipt = page.locator(`#trace-entry-${receiptRequest.ordinal}`)
    await receipt.locator('summary').click()
    await receipt
      .getByRole('button', { name: /查看原回执/ })
      .first()
      .click()
    const opened = page.locator('details[open]').filter({ has: page.locator('summary:focus') })
    await expect(opened.locator('pre')).toContainText('最终封签号')
    await expect(page.locator('.rt-detail')).not.toContainText('HIDDEN-GRANT-38')
  })
}

const grantTrace = process.env.ZERO_ACCEPTANCE_GRANT_TRACE
if (grantTrace) {
  test('opens snapshots on both sides of the actual repository grant removal', async ({ page }) => {
    const archives = JSON.parse(readFileSync(grantTrace, 'utf8')) as Array<{
      run: RouterTraceRun
      entries: RouterTraceEntry[]
    }>
    await page.route('**/api/listeners/router-traces**', (route) => {
      const found = archives.find((data) =>
        new URL(route.request().url()).pathname.endsWith(data.run.id),
      )
      return route.fulfill({ json: found ?? { items: archives.map((d) => d.run) } })
    })
    for (const [i, archive] of archives.entries()) {
      await page.goto('/router/traces?selected=' + archive.run.id)
      const entry = archive.entries.find((e) => e.kind === 'model_request')
      expect(entry).toBeDefined()
      const details = page.locator('#trace-entry-' + entry?.ordinal)
      await details.locator('summary').click()
      const raw = await details.locator('pre').innerText()
      const actual = JSON.parse(raw).request.messages
      const task = JSON.parse(actual.at(-1).content[0].text)
      expect(task.contextProvenance.githubGrantGeneration === null).toBe(i === 1)
    }
  })
}

test('a delivery link opens its exact receipt on a later trace page', async ({ page }) => {
  const run = {
    id: 'fixture-receipts',
    ordinal: 1,
    sessionId: 'router-general',
    label: 'Router 对话',
    matterId: 'm',
    status: 'completed',
    startedAt: '2026-11-05T01:00:00Z',
    endedAt: '2026-11-05T01:01:00Z',
    replayOf: null,
  }
  const received: number[] = []
  await page.route('**/api/listeners/router-traces**', (route) => {
    const url = new URL(route.request().url())
    if (!url.pathname.endsWith(run.id)) return route.fulfill({ json: { items: [run] } })
    const after = Number(url.searchParams.get('after'))
    received.push(after)
    return route.fulfill({
      json: {
        run,
        nextAfter: after === 0 ? 19 : null,
        entries: [
          {
            ordinal: after === 0 ? 19 : 29,
            runId: run.id,
            kind: after === 0 ? 'input' : 'tool_result',
            createdAt: run.startedAt,
            data:
              after === 0
                ? {}
                : {
                    name: 'publish_update',
                    id: 'exact-call',
                    result: { output: '钉钉投递回执 fixture-ref' },
                  },
          },
        ],
      },
    })
  })
  await page.goto('/router/traces?selected=fixture-receipts&entry=29')
  const receipt = page.locator('#trace-entry-29')
  await expect(receipt.locator('pre')).toContainText('fixture-ref')
  await expect(receipt.locator('summary')).toBeFocused()
  expect(received).toContain(19)
})
