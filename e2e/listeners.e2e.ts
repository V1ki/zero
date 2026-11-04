import type { TriggerInboxItem, TriggerSettingsSnapshot } from '@zero-os/shared'
import { expect, test } from './fixtures'

test('selects sources, persists their scope, and reads new events separately from scanning', async ({
  page,
}) => {
  const repo = 'example/listener-e2e'
  const session = { id: 'demo-room', name: '发布测试群' }
  let saved: TriggerSettingsSnapshot = {
    revision: 1,
    settings: { github: { credentialRef: '', repositories: [] }, wxarc: { sessions: [] } },
  }
  const item: TriggerInboxItem = {
    id: 1,
    source: 'github',
    eventId: 'run:112:1:failure',
    scope: repo,
    title: 'Release 工作流失败',
    summary: '隔离的浏览器测试构建未通过。',
    occurredAt: '2026-10-01T04:00:00Z',
    receivedAt: '2026-10-01T04:01:00Z',
    url: 'https://github.com/example/listener-e2e/actions/runs/112',
  }
  let items: TriggerInboxItem[] = []
  let scans = 0
  let sessionLookups = 0
  await page.route('**/api/listeners/**', async (route) => {
    const path = new URL(route.request().url())
    if (
      /^\/api\/listeners\/(?:routing\/|mandates\/|web-notifications(?:\/|$)|commission-grants$)/.test(
        path.pathname,
      )
    )
      return route.continue()
    switch (path.pathname) {
      case '/api/listeners/config': {
        if (route.request().method() === 'PUT') {
          const submitted = route.request().postDataJSON() as TriggerSettingsSnapshot
          expect(submitted.revision).toBe(saved.revision)
          saved = { settings: submitted.settings, revision: saved.revision + 1 }
        }
        return route.fulfill({ json: saved })
      }
      case '/api/listeners/github/repositories':
        expect(path.searchParams.get('name')).toBe(repo)
        return route.fulfill({ json: { repositories: [{ name: repo }] } })
      case '/api/listeners/wxarc/sessions':
        sessionLookups++
        return route.fulfill({ json: { sessions: [session] } })
      case '/api/listeners/status':
        return route.fulfill({ json: { statuses: [] } })
      case '/api/listeners/inbox':
        return route.fulfill({ json: { items } })
      case '/api/listeners/scan':
        expect(route.request().method()).toBe('POST')
        scans++
        if (scans === 1) {
          return route.fulfill({ status: 503, json: { error: '测试来源暂时离线' } })
        }
        items = [item]
        return route.fulfill({ json: { ok: true } })
      default:
        throw new Error(`Unexpected listener request: ${path.pathname}`)
    }
  })

  const tab = page.getByRole('button', { name: '监听与收件箱' })
  const main = page.locator('main')
  await page.goto('/config')
  await tab.click()
  await expect(page).toHaveURL(/\/config\?tab=listeners$/)
  await main.getByLabel('仓库名称').fill(repo)
  await main.getByRole('button', { name: '验证并添加' }).click()
  expect(sessionLookups).toBe(0)
  await main.getByRole('button', { name: '选择微信会话' }).click()
  await main.getByRole('checkbox', { name: session.name, exact: true }).check()
  await main.getByLabel('关键词').fill('发布失败')
  await main.getByRole('button', { name: '保存监听设置' }).click()
  await expect.poll(() => saved.revision).toBe(2)
  expect(saved.settings.github.repositories).toEqual([
    expect.objectContaining({ name: repo, enabled: true }),
  ])
  expect(saved.settings.wxarc.sessions).toEqual([
    expect.objectContaining({ ...session, enabled: true, keyword: '发布失败' }),
  ])

  await page.reload()
  await expect(main.getByLabel('关键词')).toHaveValue('发布失败')
  await main.getByRole('button', { name: '刷新收件箱' }).click()
  expect(scans).toBe(0)
  await main.getByRole('button', { name: '立即检查' }).click()
  await expect(page.getByText(/测试来源暂时离线/).first()).toBeVisible()
  await main.getByRole('button', { name: '立即检查' }).click()
  await main.locator('summary').filter({ hasText: item.title }).click()
  await expect(main.getByText(item.summary, { exact: true })).toBeVisible()
  expect(scans).toBe(2)
})
