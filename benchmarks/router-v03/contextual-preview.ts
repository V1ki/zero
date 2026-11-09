import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { TriggerStore } from '@zero-os/observe'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

const out = process.env.ZERO_ACCEPTANCE_OUTPUT
assert(out)
const store = new TriggerStore(':memory:')
const bots = (['weixin', 'dingtalk', 'feishu'] as const).map((platform) => ({
  platform,
  channelId: platform + '-fixture',
  label: platform,
  peerId: 'owner',
  operatorId: 'owner',
}))
const denied = async (): Promise<never> => {
  throw Error('Unexpected delivery while previewing')
}
let at = new Date('2026-11-09T10:00:00Z')
const runtime = new TriggerRoutingRuntime(
  store.routing,
  {
    analyze: denied,
    weixin: { listTargets: () => [], send: denied },
    personal: {
      listPersonalBots: () => bots.map((b) => ({ ...b, online: true })),
      listPersonalTargets: () => bots,
      listPersonalDirectTargets: () => bots,
      sendPersonal: denied,
      sendDirect: denied,
    },
  },
  () => at,
)
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ timezoneId: 'UTC' })
  const observations = []
  const writes: string[] = []
  await page.route('**/api/**', (route) => {
    const req = route.request(),
      url = new URL(req.url())
    if (req.method() !== 'GET') {
      if (!url.pathname.endsWith('/presence')) writes.push(url.pathname)
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname === '/api/listeners/routing/preferences')
      return route.fulfill({ json: runtime.getConfig() })
    if (url.pathname === '/api/listeners/routing/bots')
      return route.fulfill({ json: { bots: runtime.listPersonalBots() } })
    return route.continue()
  })
  for (const [date, presence, urgency, urgentDestination] of [
    ['2026-11-09T10:00', 'present', 'normal', 'weixin'],
    ['2026-11-09T10:00', 'auto', 'normal', 'weixin'],
    ['2026-11-09T10:00', 'auto', 'urgent', 'weixin'],
    ['2026-11-09T19:00', 'away', 'normal', 'weixin'],
    ['2026-11-08T10:00', 'away', 'urgent', 'dingtalk'],
  ] as const) {
    at = new Date(date + ':00Z')
    const config = runtime.getConfig()
    runtime.saveConfig(
      {
        ...config.settings,
        enabled: true,
        timeZone: 'UTC',
        workStart: '09:00',
        workEnd: '18:00',
        workdays: [1, 2, 3, 4, 5],
        notificationMode: 'contextual',
        urgentDestination,
        presence,
        duringWork: 'web',
        afterWork: 'feishu',
        offDay: 'defer',
        awayFallback: 'defer',
        personalBots: Object.fromEntries(bots.map((b) => [b.platform, b.channelId])),
      },
      config.revision,
    )
    for (const b of bots) assert(runtime.claimRouterImTarget(b))
    const actual = await runtime.previewCurrentRoute(urgency)
    await page.goto('http://localhost:3001/config?tab=listeners')
    const panel = page.getByRole('region', { name: 'Agent 与通知路由' })
    const preview = panel
      .locator('details')
      .filter({ has: page.getByText('情境预演', { exact: true }) })
    await preview.locator('summary').click()
    await preview.getByLabel(/模拟时间/).fill(date)
    await preview
      .getByLabel('模拟在场状态')
      .selectOption(presence === 'auto' ? 'inactive' : presence)
    await preview.getByLabel('模拟紧急程度').selectOption(urgency)
    const output = preview.getByRole('status')
    await expect(output).toContainText(actual.reason)
    const text = await output.innerText()
    observations.push({
      date,
      presence,
      urgency,
      savedUrgent: urgentDestination,
      runtime: actual,
      display: text,
    })
  }
  assert.deepEqual(
    observations.map((o) => o.runtime.destination),
    ['web', 'defer', 'weixin', 'feishu', 'dingtalk'],
  )
  assert.deepEqual(writes, [])
  await Bun.write(join(out, 'preview.json'), JSON.stringify({ observations, writes }, null, 2))
} finally {
  await browser.close()
  await runtime.close()
  store.close()
}
