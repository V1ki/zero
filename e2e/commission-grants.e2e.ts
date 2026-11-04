import type { CommissionGrantsView } from '@zero-os/shared'
import { expect, test } from './fixtures'

test('the local grant form records the exact operator, source and optional cross-platform destinations', async ({
  page,
}) => {
  const view: CommissionGrantsView = {
    revision: 1,
    grants: [],
    scopes: [{ source: 'github', scope: 'example/release', label: 'example/release' }],
    operators: [
      {
        platform: 'feishu',
        channelId: 'fs',
        peerId: 'research',
        operatorId: 'alice',
        label: '研究群',
      },
      {
        platform: 'dingtalk',
        channelId: 'ding',
        peerId: 'release',
        operatorId: 'bob',
        label: '发布群',
      },
    ],
    projects: [{ id: 'project', name: '研究计划' }],
    archives: [{ channelId: 'fs', documentId: 'Doc123' }],
  }
  await page.route('**/api/listeners/commission-grants', (route) => {
    if (route.request().method() === 'PUT') {
      const value = route.request().postDataJSON()
      expect(value.revision).toBe(view.revision)
      view.grants = value.grants
      view.revision++
    }
    return route.fulfill({ json: view })
  })
  await page.goto('/config?tab=listeners#mandates')
  await page.getByText('允许从 IM 管理跟踪委托', { exact: true }).click()
  const save = page.getByRole('button', { name: '授权此人管理这个来源' })
  await expect(save).toBeDisabled()
  await page.getByLabel('绑定会话和操作者').selectOption({ label: 'feishu · 研究群 · alice' })
  await page.getByLabel('允许管理的来源').selectOption({ label: 'github · example/release' })
  await page.getByLabel('其他提醒会话').selectOption({ label: 'dingtalk · 发布群' })
  await page.getByLabel('委托可用的归档文档').selectOption({ label: 'fs / Doc123' })
  await page.getByLabel('可管理提醒规则的项目').selectOption('project')
  await save.click()
  await expect(page.getByRole('button', { name: '撤销授权' })).toBeVisible()
  expect(view.grants).toEqual([
    {
      source: 'github',
      scope: 'example/release',
      operator: { platform: 'feishu', channelId: 'fs', peerId: 'research', operatorId: 'alice' },
      targets: [{ platform: 'dingtalk', channelId: 'ding', peerId: 'release', operatorId: 'bob' }],
      archive: { channelId: 'fs', documentId: 'Doc123' },
      projectId: 'project',
    },
  ])
  await page.getByRole('button', { name: '撤销授权' }).click()
  await expect(page.getByRole('button', { name: '撤销授权' })).toHaveCount(0)
  expect(view.grants).toEqual([])
})
