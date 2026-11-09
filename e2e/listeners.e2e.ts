import type { TriggerInboxItem, TriggerSettingsSnapshot } from '@zero-os/shared'
import { expect, test } from './fixtures'

test('grants a personal bot access to the GitHub connection without subscribing to a repository', async ({
  page,
}) => {
  const operator = {
    platform: 'weixin' as const,
    channelId: 'e2e-wx-bot',
    peerId: 'e2e-test-peer',
    operatorId: 'e2e-test-peer',
  }
  let saved: TriggerSettingsSnapshot = {
    revision: 1,
    settings: { github: { credentialRef: '', repositories: [] }, wxarc: { sessions: [] } },
  }
  await page.route('**/api/listeners/config', (route) => {
    if (route.request().method() === 'PUT') {
      const data = route.request().postDataJSON() as TriggerSettingsSnapshot
      expect(data.revision).toBe(saved.revision)
      saved = { revision: saved.revision + 1, settings: data.settings }
    }
    return route.fulfill({ json: saved })
  })
  await page.route('**/api/listeners/github/router-operators', (route) =>
    route.fulfill({ json: { operators: [{ ...operator, label: '个人机器人' }] } }),
  )
  await page.goto('/config?tab=listeners')
  const github = page.getByRole('region', { name: 'GitHub 监听配置' })
  const bot = github.getByRole('checkbox', { name: '微信 · 个人机器人', exact: true })
  const tracking = github.getByRole('checkbox', {
    name: '允许 Router 跟踪 GitHub 仓库',
    exact: true,
  })
  const credential = github.getByLabel('凭证名称（可选）')
  await credential.fill('github_listener')
  await expect(tracking).toHaveCount(1)
  await expect(tracking).toBeEnabled()
  await bot.check()
  await expect(tracking).not.toBeChecked()
  await page.getByRole('button', { name: '保存监听设置' }).click()
  await expect
    .poll(() => saved.settings.github)
    .toMatchObject({
      credentialRef: 'github_listener',
      repositories: [],
      routerOperators: [operator],
    })
  expect(saved.settings.github.routerTrackingEnabled ?? false).toBe(false)
  await tracking.check()
  await page.getByRole('button', { name: '保存监听设置' }).click()
  await expect.poll(() => saved.settings.github.routerTrackingEnabled).toBe(true)
  await page.reload()
  await expect(bot).toBeChecked()
  await expect(tracking).toBeChecked()
  await bot.uncheck()
  await expect(tracking).toBeChecked()
  await bot.check()
  await credential.fill('github_listener_new')
  await expect(tracking).not.toBeChecked()
  await expect(tracking).toBeDisabled()
  await page.getByRole('button', { name: '保存监听设置' }).click()
  await expect(bot).not.toBeChecked()
  expect(saved.settings.github.routerOperators).toEqual([])
  expect(saved.settings.github.routerTrackingEnabled ?? false).toBe(false)
})

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
        return route.fulfill({
          json: {
            statuses: saved.settings.github.repositories.map((r) => ({
              source: 'github',
              scope: r.name,
              state: 'watching',
              lastCheckedAt: null,
              lastIgnoredComment: {
                eventId: '42:comment:19',
                occurredAt: item.occurredAt,
                url: `https://github.com/${repo}/issues/4#issuecomment-19`,
                reason: '评论命中危险操作或敏感凭据过滤规则。',
              },
            })),
          },
        })
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
  await main.getByRole('checkbox', { name: 'Issue 状态变化' }).check()
  await main.getByRole('checkbox', { name: 'PR 状态变化' }).check()
  const issueComments = main.getByRole('checkbox', { name: 'Issue 普通评论', exact: true })
  const pullComments = main.getByRole('checkbox', { name: 'PR 普通评论', exact: true })
  await issueComments.check()
  await expect(pullComments).not.toBeChecked()
  await pullComments.check()
  await main.getByRole('checkbox', { name: 'Actions 工作流失败' }).uncheck()
  expect(sessionLookups).toBe(0)
  await main.getByRole('button', { name: '选择微信会话' }).click()
  await main.getByRole('checkbox', { name: session.name, exact: true }).check()
  await main.getByLabel('关键词').fill('发布失败')
  await main.getByRole('button', { name: '保存监听设置' }).click()
  await expect.poll(() => saved.revision).toBe(2)
  expect(saved.settings.github.repositories).toEqual([
    expect.objectContaining({
      name: repo,
      enabled: true,
      issues: true,
      pullRequests: true,
      issueComments: true,
      pullRequestComments: true,
      workflowFailures: false,
      mention: '',
    }),
  ])
  expect(saved.settings.wxarc.sessions).toEqual([
    expect.objectContaining({ ...session, enabled: true, keyword: '发布失败' }),
  ])

  await page.reload()
  await expect(main.getByLabel('关键词')).toHaveValue('发布失败')
  await expect(main.getByRole('checkbox', { name: 'Issue 状态变化' })).toBeChecked()
  await expect(main.getByRole('checkbox', { name: 'PR 状态变化' })).toBeChecked()
  await expect(issueComments).toBeChecked()
  await expect(pullComments).toBeChecked()
  await expect(main.getByText(/PR 审阅和行内评论不入箱/)).toBeVisible()
  await expect(main.getByText(/评论命中危险操作或敏感凭据过滤规则/)).toBeVisible()
  await expect(main.getByRole('link', { name: '评论', exact: true })).toHaveAttribute(
    'href',
    `https://github.com/${repo}/issues/4#issuecomment-19`,
  )
  await main.getByRole('button', { name: '刷新收件箱' }).click()
  expect(scans).toBe(0)
  await main.getByRole('button', { name: '立即检查' }).click()
  await expect(page.getByText(/测试来源暂时离线/).first()).toBeVisible()
  await main.getByRole('button', { name: '立即检查' }).click()
  await main.locator('summary').filter({ hasText: item.title }).click()
  await expect(main.getByText(item.summary, { exact: true })).toBeVisible()
  expect(scans).toBe(2)
})

test('saves independent reply and duplicate-close permissions, and revokes them as their listeners are disabled', async ({
  page,
}) => {
  const repo = {
    name: 'owner/example',
    githubAppRef: 'github_app_example',
    enabled: true,
    issueComments: true,
    pullRequestComments: true,
    workflowFailures: false,
    branch: '',
    workflow: '',
    mention: '',
  }
  let saved: TriggerSettingsSnapshot = {
    revision: 1,
    settings: { github: { credentialRef: '', repositories: [repo] }, wxarc: { sessions: [] } },
  }
  await page.route('**/api/listeners/config', (route) => {
    if (route.request().method() === 'PUT') {
      const submitted = route.request().postDataJSON() as TriggerSettingsSnapshot
      expect(submitted.revision).toBe(saved.revision)
      saved = { revision: saved.revision + 1, settings: submitted.settings }
    }
    return route.fulfill({ json: saved })
  })
  await page.goto('/config?tab=listeners')
  const section = page.getByRole('region', { name: 'GitHub 监听配置' })
  const reply = section.getByLabel('仓库所有者 @ 机器人时，在原讨论回复办理结果')
  const issues = section.getByLabel('Issue 状态变化', { exact: true })
  const closeDuplicates = section.getByLabel('自动关闭已确认重复且已有解决记录的 Issue')
  const ownerClose = section.getByLabel('允许仓库所有者 @ 机器人关闭当前 Issue')
  const issueComments = section.getByLabel('Issue 普通评论', { exact: true })
  await expect(closeDuplicates).toBeDisabled()
  await issues.check()
  await expect(closeDuplicates).not.toBeChecked()
  await closeDuplicates.check()
  await expect(ownerClose).not.toBeChecked()
  await ownerClose.check()
  await expect(reply).not.toBeChecked()
  await reply.check()
  await page.getByRole('button', { name: '保存监听设置' }).click()
  await expect.poll(() => saved.settings.github.repositories[0].ownerMentionReplies).toBe(true)
  await expect.poll(() => saved.settings.github.repositories[0].closeResolvedDuplicates).toBe(true)
  await expect.poll(() => saved.settings.github.repositories[0].allowOwnerIssueClose).toBe(true)
  await page.reload()
  await expect(reply).toBeChecked()
  await expect(closeDuplicates).toBeChecked()
  await expect(ownerClose).toBeChecked()
  await issueComments.uncheck()
  await expect(ownerClose).toBeDisabled()
  await expect(ownerClose).not.toBeChecked()
  await expect(closeDuplicates).toBeChecked()
  await expect(reply).toBeChecked()
  await issueComments.check()
  await expect(ownerClose).not.toBeChecked()
  await ownerClose.check()
  await issues.uncheck()
  await expect(closeDuplicates).not.toBeChecked()
  await expect(closeDuplicates).toBeDisabled()
  await expect(reply).toBeChecked()
  await expect(ownerClose).toBeChecked()
  await issues.check()
  await expect(closeDuplicates).not.toBeChecked()
  await closeDuplicates.check()
  await section.getByLabel('启用监听', { exact: true }).uncheck()
  await expect(reply).not.toBeChecked()
  await expect(reply).toBeDisabled()
  await expect(closeDuplicates).toBeDisabled()
  await expect(closeDuplicates).not.toBeChecked()
  await page.getByRole('button', { name: '保存监听设置' }).click()
  await expect(ownerClose).toBeDisabled()
  await expect(ownerClose).not.toBeChecked()
  await expect.poll(() => saved.settings.github.repositories[0].ownerMentionReplies).toBe(false)
  await expect.poll(() => saved.settings.github.repositories[0].closeResolvedDuplicates).toBe(false)
  await expect.poll(() => saved.settings.github.repositories[0].allowOwnerIssueClose).toBe(false)
})

test('a verified personal bot can be linked to owner matters independently of GitHub, without entering a chat id', async ({
  page,
}) => {
  let owner = { revision: 7, shared: false }
  await page.route('**/api/listeners/routing/preferences', (route) =>
    route.fulfill({
      json: {
        revision: 1,
        settings: {
          enabled: true,
          timeZone: 'Asia/Shanghai',
          workdays: [1, 2, 3, 4, 5],
          workStart: '09:00',
          workEnd: '18:00',
          presence: 'auto',
          duringWork: 'web',
          afterWork: 'defer',
          offDay: 'defer',
          awayFallback: 'defer',
          weixinTarget: null,
          personalBots: { feishu: 'reader' },
        },
      },
    }),
  )
  await page.route('**/api/listeners/routing/bots', (route) =>
    route.fulfill({
      json: {
        bots: [
          {
            platform: 'feishu',
            channelId: 'reader',
            label: '个人助手',
            online: true,
            ready: true,
            deliveryState: 'ready',
            ownerSharing: owner,
          },
        ],
      },
    }),
  )
  await page.route('**/api/listeners/routing/owner-sharing', (route) => {
    const body = route.request().postDataJSON()
    expect(body).toEqual({
      platform: 'feishu',
      channelId: 'reader',
      revision: owner.revision,
      shared: !owner.shared,
    })
    owner = { revision: owner.revision + 1, shared: body.shared }
    return route.fulfill({ json: owner })
  })
  await page.goto('/config?tab=listeners')
  const control = page.getByRole('checkbox', { name: '允许飞书本人私聊继续网页事项' })
  await expect(control).not.toBeChecked()
  await control.check()
  await expect(control).toBeChecked()
  await expect.poll(() => owner.revision).toBe(8)
  await page.reload()
  await expect(control).toBeChecked()
  await control.uncheck()
  await expect(control).not.toBeChecked()
  await expect.poll(() => owner.revision).toBe(9)
})
