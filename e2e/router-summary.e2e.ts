import type { RouterSummary, RouterSummaryCounts } from '@zero-os/shared'
import { expect, test } from './fixtures'

const zero: RouterSummaryCounts = {
  notifications: { personal: 0, mandate: 0 },
  triage: { filtered: 0, restored: 0 },
  investigation: { notified: 0, unread: 0, unfinished: 0, expired: 0 },
  reports: {
    completed: 0,
    ready: 0,
    raw: 0,
    pending: 0,
    unrequested: 0,
    expired: 0,
    decisions: 0,
    answered: 0,
    recommended: 0,
  },
}
const week: RouterSummary = {
  days: 7,
  current: {
    from: '2026-11-04T04:00:00.000Z',
    to: '2026-11-11T04:00:00.000Z',
    counts: {
      notifications: { personal: 4, mandate: 9 },
      triage: { filtered: 8, restored: 3 },
      investigation: { notified: 6, unread: 2, unfinished: 1, expired: 0 },
      reports: {
        ...zero.reports,
        completed: 7,
        ready: 6,
        raw: 1,
        decisions: 3,
        answered: 2,
        recommended: 2,
      },
    },
  },
  previous: {
    from: '2026-10-28T04:00:00.000Z',
    to: '2026-11-04T04:00:00.000Z',
    counts: {
      notifications: { personal: 9, mandate: 14 },
      triage: { filtered: 2, restored: 0 },
      investigation: { notified: 3, unread: 0, unfinished: 0, expired: 0 },
      reports: { ...zero.reports, completed: 4, ready: 2, raw: 2, decisions: 1, answered: 1 },
    },
  },
  recordedSince: '2026-11-06T02:00:00.000Z',
  retentionDays: 30,
}
const month: RouterSummary = {
  ...week,
  days: 30,
  current: { ...week.current, from: '2026-10-12T04:00:00.000Z', counts: zero },
  previous: { from: '2026-09-12T04:00:00.000Z', to: '2026-10-12T04:00:00.000Z', counts: zero },
  retentionDays: null,
}

test('the summary view is one of the workspace views, leads with sentences and switches windows', async ({
  page,
}) => {
  const requested: (string | null)[] = []
  await page.route('**/api/listeners/workspace-summary**', (route) => {
    const days = new URL(route.request().url()).searchParams.get('days')
    requested.push(days)
    return route.fulfill({ json: days === '30' ? month : week })
  })
  await page.goto('/router')
  const views = page.getByRole('navigation', { name: '工作台视图' })
  await views.getByRole('link', { name: '效果统计' }).click()
  await expect(page).toHaveURL(/\/router\?view=summary$/)
  await expect(views.getByRole('link', { name: '效果统计' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.getByRole('heading', { level: 2, name: 'Router 效果统计' })).toBeVisible()
  // Exactly one view is marked as the current one.
  await expect(views.locator('[aria-current="page"]')).toHaveCount(1)
  for (const heading of ['通知', '分诊', '调查', '派工汇报', '这些数字怎么算'])
    await expect(page.getByRole('heading', { level: 3, name: heading })).toBeVisible()

  const notifications = page.getByRole('region', { name: '通知' })
  await expect(notifications).toContainText(
    '近 7 天发出了 13 条通知，另有 8 条事件被分诊过滤，没有打扰你。之前的 7 天发出了 23 条。',
  )
  await expect(notifications.getByRole('definition').first()).toContainText('4之前 9')
  const triage = page.getByRole('region', { name: '分诊' })
  await expect(triage).toContainText('近 7 天分诊过滤了 11 条事件')
  // 3 of 11 restored and 2 of 6 investigations unread pass both the minimum and the share.
  await expect(triage).toContainText('值得看一眼：过滤掉的事件有 27% 被你找了回来')
  await expect(page.getByRole('region', { name: '调查' })).toContainText(
    '监听凭证的读取权限可能不够',
  )
  const reports = page.getByRole('region', { name: '派工汇报' })
  await expect(reports).toContainText('你回答了 2 个，其中 2 个选的是推荐项。')
  await expect(reports).not.toContainText('值得看一眼')
  const coverage = page.getByRole('region', { name: '这些数字怎么算' })
  await expect(coverage).toContainText('本机正文保留 30 天')
  await expect(coverage).toContainText('近 7 天和之前的 7 天里早于这个时间的记录没有这两项')

  const window = page.getByRole('group', { name: '统计范围' })
  await expect(window.getByRole('button', { name: '近 7 天' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await window.getByRole('button', { name: '近 30 天' }).click()
  await expect(window.getByRole('button', { name: '近 30 天' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(reports).toContainText('近 30 天没有完成的派工。之前的 30 天没有完成的派工。')
  await expect(notifications).toContainText('近 30 天没有发出通知，也没有事件被分诊过滤。')
  await expect(page.getByText('值得看一眼')).toHaveCount(0)
  await expect(page.locator('.rs-summary')).not.toContainText('NaN')
  expect(requested).toEqual(['7', '30'])

  // The other views stay reachable from the same navigation.
  await views.getByRole('link', { name: '网页提醒' }).click()
  await expect(page).toHaveURL(/view=notifications/)
  await expect(page.getByRole('heading', { name: 'Router 效果统计' })).toHaveCount(0)
})
