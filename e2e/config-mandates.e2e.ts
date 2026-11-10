import type { TriggerMandate, TriggerMandateSnapshot } from '@zero-os/shared'
import { expect, test } from './fixtures'

const base = '/api/listeners/mandates'
const repo = 'example/release'
const oldRule: TriggerMandate = {
  id: 'stability',
  enabled: true,
  name: '构建稳定性',
  purpose: '观察构建失败的频率',
  source: 'github',
  scope: repo,
  keyword: '',
  projectId: null,
  targets: [],
  archive: null,
  policy: { offDay: 'none' },
  deadline: null,
  urgent: false,
}

test('saves two purposes in the same scope, previews independently, and preserves a stale editing draft', async ({
  page,
}) => {
  let snapshot: TriggerMandateSnapshot = {
    revision: 8,
    settings: { mandates: [oldRule], projects: [] },
  }
  let saves = 0
  let verified = 0
  let previews = 0
  await page.route('**/api/listeners/config', (route) =>
    route.fulfill({
      json: {
        revision: 2,
        settings: {
          github: {
            credentialRef: '',
            repositories: [
              {
                name: repo,
                enabled: true,
                branch: '',
                workflow: '',
                workflowFailures: true,
                mention: '',
              },
            ],
          },
          wxarc: { sessions: [] },
        },
      },
    }),
  )
  await page.route(`**${base}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    const request = route.request()
    if (path === `${base}/config`) {
      if (request.method() === 'PUT') {
        const draft = request.postDataJSON() as TriggerMandateSnapshot
        if (snapshot.revision !== draft.revision)
          return route.fulfill({ status: 409, json: { error: '委托版本已变化' } })
        snapshot = { revision: draft.revision + 1, settings: draft.settings }
        saves++
      }
      return route.fulfill({ json: snapshot })
    }
    if (path === `${base}/targets`)
      return route.fulfill({
        json: {
          targets: [
            {
              platform: 'weixin',
              channelId: 'wx-main',
              peerId: 'private-a',
              label: '发布负责人',
              operatorId: 'private-a',
            },
            {
              platform: 'feishu',
              channelId: 'fs-main',
              peerId: 'research',
              operatorId: 'one',
              label: '研究群 · 同事一',
            },
            {
              platform: 'feishu',
              channelId: 'fs-main',
              peerId: 'research',
              operatorId: 'two',
              label: '研究群 · 同事二',
            },
          ],
          archiveChannels: [{ channelId: 'fs-main', label: '研究文档' }],
        },
      })
    if (path === `${base}/documents/verify`) {
      expect(request.postDataJSON()).toEqual({ channelId: 'fs-main', documentId: 'Doc123' })
      verified++
      return route.fulfill({ json: { writable: true } })
    }
    if (path === `${base}/preview`) {
      expect(request.postDataJSON()).toMatchObject({
        mandateId: snapshot.settings.mandates[1].id,
        present: false,
        urgent: true,
      })
      previews++
      return route.fulfill({
        json: {
          decision: { destination: 'weixin', reason: '委托已标记紧急，采用紧急例外' },
          archive: snapshot.settings.mandates[1].archive,
        },
      })
    }
    return route.continue()
  })
  await page.goto('/config?tab=listeners#mandates')
  const panel = page.getByRole('region', { name: '长期委托与项目' })
  const processing = panel.getByRole('combobox', { name: '事件处理方式' })
  await expect(processing).toHaveValue('agent')
  await panel.getByRole('button', { name: '项目 · 0' }).click()
  await panel.getByRole('button', { name: '新增项目' }).click()
  await panel.getByLabel('项目名称').fill('发布工程')
  await panel.getByRole('combobox', { name: '休息日', exact: true }).selectOption('none')
  await panel.getByRole('button', { name: '委托 · 1' }).click()
  await panel.getByRole('button', { name: '新增委托' }).click()
  await expect(processing).toHaveValue('agent')
  await processing.selectOption('investigate')
  await expect(panel.getByText(/只读查看该仓库自身的 Actions 失败记录或 PR 记录/)).toBeVisible()
  const source = panel.getByRole('combobox', { name: '委托来源', exact: true })
  await source.selectOption('wxarc')
  await expect(processing).toHaveValue('agent')
  await expect(processing.locator('option[value="investigate"]')).toHaveCount(0)
  await source.selectOption('github')
  await expect(processing.locator('option[value="investigate"]')).toHaveCount(1)
  await processing.selectOption('direct')
  await expect(panel.getByText(/按固定格式整理命中事件，无需调用模型/)).toBeVisible()
  await panel.getByLabel('委托名称').fill('发布阻塞')
  await panel.getByLabel('跟踪目的').fill('找出阻塞本次发布的失败并提醒负责人')
  await panel
    .getByRole('combobox', { name: '所属项目', exact: true })
    .selectOption({ label: '发布工程' })
  await panel.getByRole('combobox', { name: '已监听的仓库', exact: true }).selectOption(repo)
  await panel.getByRole('combobox', { name: '任务归并', exact: true }).selectOption('mandate')
  await panel.getByLabel('紧急委托').check()
  await panel.getByText('提醒受众与成果归档', { exact: true }).click()
  await panel
    .getByRole('combobox', { name: '微信接收会话', exact: true })
    .selectOption({ label: '发布负责人 · private-a' })
  await panel
    .getByRole('combobox', { name: '飞书接收会话' })
    .selectOption({ label: '研究群 · 同事二 · research' })
  await expect(panel.getByText('授权操作人 · two')).toBeVisible()
  await panel.getByLabel('同时归档到指定飞书文档').check()
  await panel.getByRole('combobox', { name: '归档用飞书账号', exact: true }).selectOption('fs-main')
  await panel.getByLabel('飞书文档 ID').fill('Doc123')
  await panel.getByRole('button', { name: '检查文档写权限' }).click()
  await expect(panel.getByText('此账号可写入该文档')).toBeVisible()
  await panel.getByText('覆盖此委托的时段与提醒偏好', { exact: true }).click()
  await panel.getByRole('combobox', { name: '紧急例外', exact: true }).selectOption('weixin')
  await panel.getByLabel('指定日期例外').fill('2026-11-07')
  await panel.getByRole('button', { name: '加入例外' }).click()
  await panel.getByRole('button', { name: '保存委托与项目' }).click()
  await expect.poll(() => saves).toBe(1)
  expect(snapshot.settings.mandates[0]).toEqual(oldRule)
  expect(snapshot.settings.mandates[1]).toMatchObject({
    scope: repo,
    groupBy: 'mandate',
    processing: 'direct',
    urgent: true,
    projectId: snapshot.settings.projects[0].id,
    policy: { urgentDestination: 'weixin', dateOverrides: { '2026-11-07': 'work' } },
    archive: { channelId: 'fs-main', documentId: 'Doc123' },
    targets: [
      { platform: 'weixin', channelId: 'wx-main', peerId: 'private-a', operatorId: 'private-a' },
      { platform: 'feishu', channelId: 'fs-main', peerId: 'research', operatorId: 'two' },
    ],
  })
  await page.reload()
  await panel.getByRole('button', { name: /发布阻塞/ }).click()
  await expect(processing).toHaveValue('direct')
  await panel.getByText('预演这条委托', { exact: true }).click()
  await panel.getByRole('combobox', { name: '预演在场状态', exact: true }).selectOption('away')
  await panel.getByRole('combobox', { name: '预演紧急程度', exact: true }).selectOption('urgent')
  await panel.getByRole('button', { name: '运行委托预演' }).click()
  await expect(panel.getByText('委托已标记紧急，采用紧急例外')).toBeVisible()
  expect({ verified, previews, saves }).toEqual({ verified: 1, previews: 1, saves: 1 })
  await panel.getByLabel('委托名称').fill('另一个窗口也在编辑')
  snapshot = { ...snapshot, revision: snapshot.revision + 1 }
  await panel.getByRole('button', { name: '保存委托与项目' }).click()
  await expect(panel.getByRole('alert')).toContainText('委托版本已变化')
  await expect(panel.getByLabel('委托名称')).toHaveValue('另一个窗口也在编辑')
  await panel.getByRole('button', { name: '放弃委托草稿并重新载入' }).click()
  await expect(panel.getByLabel('委托名称')).toHaveValue('发布阻塞')
  expect(saves).toBe(1)
})

test('persists project policy through the local service and reloads date exceptions', async ({
  page,
  request,
}) => {
  const name = `休假发布测试-${crypto.randomUUID().slice(0, 8)}`
  await page.goto('/config?tab=listeners#mandates')
  const panel = page.getByRole('region', { name: '长期委托与项目' })
  await panel.getByRole('button', { name: /^项目 ·/ }).click()
  await panel.getByRole('button', { name: '新增项目' }).click()
  await panel.getByLabel('项目名称').fill(name)
  await panel.getByRole('combobox', { name: '休息日', exact: true }).selectOption('none')
  await panel.getByLabel('指定日期例外').fill('2027-01-02')
  await panel.getByRole('combobox', { name: '日期类型', exact: true }).selectOption('work')
  await panel.getByRole('button', { name: '加入例外' }).click()
  await panel.getByRole('button', { name: '保存委托与项目' }).click()
  await expect(panel.getByText('委托与项目已保存')).toBeVisible()
  const saved = await request.get(`${base}/config`)
  expect(saved.ok()).toBeTruthy()
  const snapshot = (await saved.json()) as TriggerMandateSnapshot
  expect(snapshot.settings.projects.find((row) => row.name === name)?.policy).toMatchObject({
    offDay: 'none',
    dateOverrides: { '2027-01-02': 'work' },
  })
  await page.reload()
  await panel.getByRole('button', { name: /^项目 ·/ }).click()
  await panel.getByRole('button', { name: new RegExp(name) }).click()
  await expect(panel.getByRole('combobox', { name: '休息日', exact: true })).toHaveValue('none')
  await expect(panel.getByRole('button', { name: '移除日期例外 2027-01-02' })).toBeVisible()
  await panel.getByRole('button', { name: '移除这个项目' }).click()
  await panel.getByRole('button', { name: '保存委托与项目' }).click()
  await expect(panel.getByText('委托与项目已保存')).toBeVisible()
})
