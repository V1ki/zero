import type { TriggerGithubPermissionReport, TriggerSettingsSnapshot } from '@zero-os/shared'
import { expect, test } from './fixtures'

test('checks only selected repository reads, distinguishes inconclusive results and drops stale checks', async ({
  page,
}) => {
  const repo = {
    name: 'example/release',
    enabled: false,
    workflowFailures: true,
    branch: 'main',
    workflow: 'ci',
    mention: 'reviewer',
  }
  const another = {
    ...repo,
    name: 'example/research',
    mention: '',
    githubAppRef: 'github_app_zero_router',
  }
  const config: TriggerSettingsSnapshot = {
    revision: 1,
    settings: {
      github: { credentialRef: '', repositories: [repo, another] },
      wxarc: { sessions: [] },
    },
  }
  let configWrites = 0
  await page.route('**/api/listeners/config', async (route) => {
    if (route.request().method() !== 'GET') configWrites++
    return route.fulfill({ json: config })
  })
  const requests: unknown[] = []
  const releaseLate = Promise.withResolvers<void>()
  const lateFinished = Promise.withResolvers<void>()
  await page.route('**/api/listeners/github/permissions', async (route) => {
    expect(route.request().method()).toBe('POST')
    requests.push(route.request().postDataJSON())
    let report: TriggerGithubPermissionReport
    if (requests.length === 1) {
      report = {
        access: 'anonymous',
        checks: [
          { resource: 'actions', status: 'readable' },
          { resource: 'prComments', status: 'not_found' },
          { resource: 'prBase', status: 'rate_limited', retryAfterMs: 61_001 },
        ],
      }
    } else if (requests.length === 4) {
      report = {
        access: 'credential',
        checks: [
          { resource: 'issueComments', status: 'readable' },
          { resource: 'pullRequestComments', status: 'readable' },
        ],
      }
    } else {
      report = {
        access: 'credential',
        checks: [
          { resource: 'actions', status: 'denied' },
          { resource: 'prComments', status: 'unavailable' },
        ],
      }
    }
    if (requests.length === 3) {
      await releaseLate.promise
      try {
        await route.fulfill({ json: report })
      } finally {
        lateFinished.resolve()
      }
      return
    }
    return route.fulfill({ json: report })
  })

  await page.goto('/config?tab=listeners')
  const first = page.getByRole('region', { name: `${repo.name} 读取权限` })
  const second = page.getByRole('region', { name: `${another.name} 读取权限` })
  const card = page.locator('.listener-item').filter({ has: first })
  const button = first.getByRole('button', { name: '检查读取权限' })
  await expect(button).toBeEnabled()
  await expect(card.getByRole('checkbox', { name: '启用监听' })).not.toBeChecked()
  await expect(second).not.toContainText('PR 目标分支')
  await expect(second).toContainText('github_app_zero_router')
  await expect(first).not.toContainText('github_app_zero_router')
  await button.click()
  await expect(first).toContainText('匿名访问结果')
  await expect(first).toContainText('返回 404，无法确认仓库或该资源的可见范围')
  await expect(first).toContainText('62 秒后可重试')
  await expect(second).not.toContainText('匿名访问结果')
  expect(requests[0]).toEqual({
    name: repo.name,
    credentialRef: '',
    workflowFailures: true,
    prComments: true,
    prBase: true,
  })

  const credential = page.getByLabel('凭证名称（可选）', { exact: true })
  await credential.fill('github_listener_team')
  await expect(first).not.toContainText('匿名访问结果')
  await card.getByLabel('分支（PR 按目标分支）').fill('')
  await button.click()
  await expect(first).toContainText('所选凭证的读取结果')
  await expect(first).toContainText('拒绝读取')
  await expect(first).toContainText('暂时无法核实')
  expect(requests[1]).toEqual({
    name: repo.name,
    credentialRef: 'github_listener_team',
    workflowFailures: true,
    prComments: true,
    prBase: false,
  })

  await button.click()
  await expect.poll(() => requests.length).toBe(3)
  await card.getByLabel('工作流', { exact: true }).fill('test-build')
  await expect(first).not.toContainText('所选凭证的读取结果')
  releaseLate.resolve()
  await lateFinished.promise
  await expect(first).not.toContainText('所选凭证的读取结果')

  await credential.fill('invalid_credential')
  await expect(button).toBeDisabled()
  await expect(card.getByRole('checkbox', { name: '启用监听' })).not.toBeChecked()
  expect(requests).toHaveLength(3)

  const otherCard = page.locator('.listener-item').filter({ has: second })
  await credential.fill('github_listener_team')
  await otherCard.getByLabel('分支（PR 按目标分支）').fill('')
  await otherCard.getByRole('checkbox', { name: 'Actions 工作流失败' }).uncheck()
  await otherCard.getByRole('checkbox', { name: 'Issue 普通评论', exact: true }).check()
  await otherCard.getByRole('checkbox', { name: 'PR 普通评论', exact: true }).check()
  await second.getByRole('button', { name: '检查读取权限' }).click()
  await expect(second.getByRole('listitem')).toHaveCount(2)
  await expect(second.getByRole('listitem').filter({ hasText: '可读取' })).toHaveCount(2)
  expect(requests[3]).toEqual({
    name: another.name,
    credentialRef: 'github_listener_team',
    workflowFailures: false,
    prComments: false,
    prBase: false,
    issueComments: true,
    pullRequestComments: true,
  })
  expect(configWrites).toBe(0)
})
