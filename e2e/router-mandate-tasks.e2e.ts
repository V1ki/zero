import type { MandateEffect, MandateTaskDetail, RouterTaskJob } from '@zero-os/shared'
import { expect, test } from './fixtures'

const receipt = (kind: 'notify' | 'archive', status: MandateEffect['status']): MandateEffect => ({
  kind,
  status,
  destination: kind === 'archive' ? 'archive' : 'web',
  target: kind === 'archive' ? { channelId: 'research', documentId: 'releaseLog' } : null,
  receipt: status === 'failed' ? '文档服务暂不可用' : null,
  reason: kind === 'archive' ? '保存研究结论' : '当前网页在场',
  dueAt: null,
})

test('follows a task across events, retries only the failed effect, and separates the task conversation from its original events', async ({
  page,
}) => {
  const task: MandateTaskDetail = {
    id: 8,
    title: '发布检查跟进',
    mandateId: 'release-checks',
    active: true,
    paused: false,
    latestInboxId: 31,
    businessKey: 'pr:18',
    acknowledgedAt: '2026-11-04T08:45:00.000Z',
    acknowledgedBy: {
      platform: 'dingtalk',
      channelId: '发布机器人',
      peerId: '发布群',
      operatorId: '测试负责人',
    },
    sessionId: null,
    updatedAt: '2026-11-04T02:00:00Z',
    eventCount: 2,
    matches: [31, 21].map((inboxId, index) => ({
      id: 104 - index,
      inboxId,
      mandateId: 'release-checks',
      taskId: 8,
      status: 'ready',
      summary: index ? '首次失败' : '再次失败',
      error: null,
      effects: [receipt('notify', 'done'), receipt('archive', index ? 'unknown' : 'failed')],
    })),
  }
  const retries: unknown[] = []
  const jobs: RouterTaskJob[] = [
    { id: 12, executor: 'zero', status: 'running', updatedAt: '2026-11-04T02:00:00Z' },
    {
      id: 11,
      executor: 'codex',
      status: 'completed',
      updatedAt: '2026-11-04T01:00:00Z',
      verdict: '发布脚本的测试已修好。',
    },
  ]
  await page.route('**/api/listeners/workspace/task-8/jobs', (route) =>
    route.fulfill({ json: { items: jobs } }),
  )
  await page.route('**/api/listeners/mandates/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api/listeners/mandates', '')
    switch (path) {
      case '/config':
        return route.fulfill({
          json: {
            revision: 1,
            settings: {
              projects: [],
              mandates: [{ id: task.mandateId, name: '发布委托', purpose: '汇总稳定性问题' }],
            },
          },
        })
      case '/tasks':
        return route.fulfill({ json: { items: [task] } })
      case '/tasks/8':
        return route.fulfill({ json: task })
      case '/tasks/8/pause':
        expect(request.method()).toBe('PUT')
        task.paused = request.postDataJSON().paused
        if (task.paused) task.matches[0].effects[1] = receipt('archive', 'revoked')
        return route.fulfill({ json: task })
      case '/records/104/retry': {
        expect(request.method()).toBe('POST')
        const body = request.postDataJSON()
        retries.push(body)
        expect(body).toEqual({ kind: 'archive' })
        task.matches[0].effects[1] = receipt('archive', 'pending')
        return route.fulfill({ status: 202, json: { accepted: true } })
      }
      default:
        throw new Error(`Unexpected mandate request: ${path}`)
    }
  })
  await page.goto('/router?view=tasks')
  const rail = page.getByRole('navigation', { name: '持续任务' })
  await rail.getByRole('link', { name: /发布检查跟进/ }).click()
  await expect(page).toHaveURL(/\/router\?task=8$/)
  await page.reload()
  const timeline = page.getByRole('region', { name: '任务时间线' })
  await expect(timeline.getByText(/跟进人 测试负责人/)).toContainText(
    '钉钉 · 应用 发布机器人 · 会话 发布群',
  )
  task.acknowledgedBy = null
  await page.reload()
  await expect(timeline.getByText(/确认跟进/)).toBeVisible()
  await expect(timeline).not.toContainText('测试负责人')
  task.acknowledgedAt = null
  await page.reload()
  await expect(timeline.getByText(/确认跟进/)).toHaveCount(0)
  const jobList = timeline.getByRole('list', { name: '派工记录' })
  await expect(jobList.getByRole('listitem')).toHaveText([
    /派工 #12.*ZeRo · 执行中/,
    /派工 #11.*Codex · 已完成.*发布脚本的测试已修好。/,
  ])
  await expect(jobList.getByRole('link', { name: '派工 #11' })).toHaveAttribute(
    'href',
    '/router?task=8&view=chat',
  )
  const latest = timeline.getByRole('listitem').filter({ hasText: '再次失败' })
  const first = timeline.getByRole('listitem').filter({ hasText: '首次失败' })
  await expect(latest.getByRole('region', { name: '提醒' })).toContainText('已完成')
  await expect(latest.getByRole('region', { name: '归档' })).toContainText('文档服务暂不可用')
  await expect(first.getByRole('region', { name: '归档' })).toContainText('结果待核对')
  await expect(first.getByRole('button', { name: '重试归档' })).toHaveCount(0)
  await latest.getByRole('button', { name: '重试归档' }).click()
  await expect(latest.getByRole('region', { name: '归档' })).toContainText('待处理')
  await expect(latest.getByRole('region', { name: '提醒' })).toContainText('已完成')
  expect(retries).toEqual([{ kind: 'archive' }])
  await timeline.getByRole('button', { name: '暂停任务' }).click()
  await expect(latest.getByRole('region', { name: '归档' })).toContainText('已撤销')
  await timeline.getByRole('button', { name: '恢复任务' }).click()
  await expect(timeline.getByText('跟踪中', { exact: true })).toBeVisible()
  await expect(timeline.getByRole('link', { name: '继续任务对话' })).toHaveAttribute(
    'href',
    '/router?task=8&view=chat',
  )

  task.active = false
  await page.reload()
  await expect(timeline.getByText('已终止', { exact: true })).toBeVisible()
  await expect(timeline.getByRole('button', { name: '暂停任务' })).toHaveCount(0)
  await expect(timeline.getByRole('link', { name: '查看任务对话' })).toHaveAttribute(
    'href',
    '/router?task=8&view=chat',
  )
  const firstEvent = timeline.getByRole('link', { name: '原始事件 #21' })
  await expect(firstEvent).toHaveAttribute('href', '/router?event=21')
  const eventRequest = page.waitForRequest(
    (req) => new URL(req.url()).pathname === '/api/listeners/workspace/21',
  )
  await firstEvent.click()
  await expect(page).toHaveURL(/\/router\?event=21$/)
  await eventRequest
})
