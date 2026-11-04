import type { Locator } from '@playwright/test'
import type {
  MandateDestination,
  TriggerMandateSnapshot,
  TriggerRoutingSettings,
} from '@zero-os/shared'
import { mandateSnapshot } from '../apps/server/src/triggers/mandate-input'
import { decideMandateNotification } from '../apps/server/src/triggers/mandate-policy'
import { expect, test } from './fixtures'

const repository = 'example/ordered-rules'
const target = {
  platform: 'weixin',
  channelId: 'owner-account',
  peerId: 'owner-peer',
  operatorId: 'owner-peer',
} as const
const schedule: TriggerRoutingSettings = {
  enabled: true,
  timeZone: 'UTC',
  workdays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '18:00',
  presence: 'present',
  duringWork: 'defer',
  afterWork: 'defer',
  offDay: 'defer',
  awayFallback: 'defer',
  weixinTarget: null,
}

test.use({ timezoneId: 'UTC' })

async function addRule(
  panel: Locator,
  position: number,
  name: string,
  destination: MandateDestination,
) {
  await panel.getByRole('button', { name: '添加情境规则' }).click()
  const rule = panel.getByRole('group', { name: `规则 ${position}`, exact: true })
  await rule.getByLabel('规则名称').fill(name)
  await rule.getByRole('combobox', { name: '适用时段' }).selectOption('')
  await rule.getByRole('combobox', { name: '在场条件' }).selectOption('present')
  await rule.getByRole('combobox', { name: '命中去向' }).selectOption(destination)
}

test('saves and reorders competing contextual rules, and falls back to the project when the mandate rules are removed', async ({
  page,
}) => {
  let snapshot: TriggerMandateSnapshot = {
    revision: 4,
    settings: {
      projects: [{ id: 'release', name: '发布工程', policy: {} }],
      mandates: [
        {
          id: 'ci',
          name: '发布检查',
          enabled: true,
          purpose: '跟踪发布检查',
          source: 'github',
          scope: repository,
          keyword: '',
          projectId: 'release',
          targets: [target],
          archive: null,
          policy: {},
          deadline: null,
          urgent: false,
        },
      ],
    },
  }
  await page.route('**/api/listeners/config', (route) =>
    route.fulfill({
      json: {
        revision: 1,
        settings: {
          github: {
            credentialRef: '',
            repositories: [
              {
                name: repository,
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
  await page.route('**/api/listeners/mandates/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/config')) {
      if (request.method() === 'PUT') {
        const next = mandateSnapshot(request.postDataJSON())
        expect(next.revision).toBe(snapshot.revision)
        snapshot = { ...next, revision: next.revision + 1 }
      }
      return route.fulfill({ json: snapshot })
    }
    if (path.endsWith('/targets'))
      return route.fulfill({
        json: { targets: [{ ...target, label: '本人' }], archiveChannels: [] },
      })
    if (path.endsWith('/preview')) {
      const body = request.postDataJSON()
      expect(body).toMatchObject({ mandateId: 'ci', present: true, at: '2026-11-02T10:00:00.000Z' })
      const mandate = snapshot.settings.mandates[0]
      const decision = decideMandateNotification({
        mandate,
        project: snapshot.settings.projects[0],
        settings: schedule,
        now: new Date(body.at),
        receivedAt: body.at,
        availableTargets: [target],
      })
      return route.fulfill({ json: { decision, archive: mandate.archive } })
    }
    return route.continue()
  })
  await page.goto('/config?tab=listeners#mandates')
  const panel = page.getByRole('region', { name: '长期委托与项目' })
  const save = async () => {
    const previous = snapshot.revision
    await panel.getByRole('button', { name: '保存委托与项目' }).click()
    await expect.poll(() => snapshot.revision).toBe(previous + 1)
    await expect(panel.getByText('委托与项目已保存')).toBeVisible()
  }
  const preview = async (destination: string, reason: string) => {
    await panel.getByText('预演这条委托', { exact: true }).click()
    await panel.getByLabel('预演时间').fill('2026-11-02T10:00')
    await panel.getByRole('button', { name: '运行委托预演' }).click()
    const result = panel.locator('output.mandate-preview')
    await expect(result.locator('strong')).toHaveText(destination)
    await expect(result).toContainText(reason)
    return result
  }
  const editMandate = async () => {
    await panel.getByText('覆盖此委托的时段与提醒偏好', { exact: true }).click()
    await panel.getByText('自定义情境顺序', { exact: true }).click()
  }

  await panel.getByRole('button', { name: '项目 · 1' }).click()
  await panel.getByText('自定义情境顺序', { exact: true }).click()
  await addRule(panel, 1, '项目稍后汇总', 'defer')
  await save()

  await panel.getByRole('button', { name: '委托 · 1' }).click()
  await editMandate()
  await addRule(panel, 1, '在场时网页详报', 'web')
  await addRule(panel, 2, '在场时微信简报', 'weixin')
  const lead = panel.getByLabel('截止前多久使用紧急例外（分钟）')
  await lead.fill('10081')
  await expect(panel.getByRole('button', { name: '保存委托与项目' })).toBeDisabled()
  await lead.fill('90')
  await save()
  const ruleIds = snapshot.settings.mandates[0].policy.rules?.map((rule) => rule.id)
  expect(new Set(ruleIds).size).toBe(2)
  await preview('网页展示', '在场时网页详报')

  await page.reload()
  await editMandate()
  await expect(lead).toHaveValue('90')
  const first = panel.getByRole('group', { name: '规则 1', exact: true })
  const second = panel.getByRole('group', { name: '规则 2', exact: true })
  await expect(first.getByLabel('规则名称')).toHaveValue('在场时网页详报')
  await second.getByRole('button', { name: '上移' }).click()
  await expect(first.getByLabel('规则名称')).toHaveValue('在场时微信简报')
  await lead.fill('0')
  await save()

  await page.reload()
  expect(snapshot.settings.mandates[0].policy.rules?.map((rule) => rule.id)).toEqual(
    ruleIds?.toReversed(),
  )
  const result = await preview('微信', '在场时微信简报')
  await expect(result).toContainText('owner-account / owner-peer')
  await editMandate()
  await expect(first.getByLabel('规则名称')).toHaveValue('在场时微信简报')
  await expect(lead).toHaveValue('0')
  await second.getByRole('button', { name: '删除规则' }).click()
  await first.getByRole('button', { name: '删除规则' }).click()
  await lead.fill('')
  await save()

  await page.reload()
  await preview('延后提醒', '项目稍后汇总')
})
