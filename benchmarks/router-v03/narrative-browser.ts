import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { Database } from 'bun:sqlite'
const output = process.env.ZERO_ACCEPTANCE_OUTPUT
assert(output)
const data = JSON.parse(readFileSync(join(output, 'narratives.json'), 'utf8')) as {
  results: { pub: string }[]
}
const db = new Database(join(output, 'workspace.sqlite'), { readwrite: true, create: false })
db.exec('PRAGMA query_only=ON')
// Read the already-published records, including the model's original UI, without writing even to the fixture.
const publications = data.results.map(({ pub }) => {
  const row = db
    .query<{ id: string; matterId: string; createdAt: string }, [string]>(
      'SELECT id,matter_id AS matterId,created_at AS createdAt FROM router_publications WHERE id=?',
    )
    .get(pub)
  assert(row)
  const deliveries = db
    .query<{ channel: string; status: string; presentation: string }, [string]>(
      'SELECT channel,status,presentation FROM router_publication_deliveries WHERE publication_id=?',
    )
    .all(pub)
  return {
    ...row,
    deliveries: deliveries.map((d) => ({ ...d, presentation: JSON.parse(d.presentation) })),
  }
})
db.close()
const base = process.env.ZERO_ACCEPTANCE_BROWSER_URL ?? 'http://localhost:3001'
const browser = await chromium.launch()
try {
  const proof = []
  for (const size of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    const page = await browser.newPage({ viewport: size })
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== base || !['GET', 'HEAD'].includes(route.request().method()))
        return route.abort()
      return url.pathname === '/api/listeners/router-publications'
        ? route.fulfill({ json: publications })
        : route.continue()
    })
    await page.goto(base + '/router?view=notifications')
    const rows = page.getByRole('region', { name: 'Router 交付与各平台回执' }).locator('article')
    await expect(rows).toHaveCount(2)
    const facts = []
    for (let i = 0; i < 2; i++) {
      const row = rows.nth(i),
        summary = row.getByText('完整文字与证据链接', { exact: true })
      const surface = row.getByRole('region', { name: '交互卡片' }).first()
      await expect(surface).toBeVisible()
      const visible = await surface.innerText()
      assert(
        i === 0
          ? visible.includes('#145') && /未合并|开放/.test(visible)
          : visible.includes('#163') && /缺|待|未/.test(visible),
      )
      await summary.focus()
      await page.keyboard.press('Enter')
      const detail = summary.locator('..')
      await expect(detail).toHaveAttribute('open', '')
      const sources = await detail
        .locator('a')
        .evaluateAll((a) => a.map((el) => (el as HTMLAnchorElement).href))
      assert(
        sources.includes(
          'https://github.com/V1ki/dsh-plugin-subscriptions/pull/' + (i === 0 ? 145 : 163),
        ),
      )
      const text = await detail.innerText()
      if (i === 1) assert(/mergeAllowed|允许合并|写权限/.test(text))
      const receipts = row.getByText('查看各平台投递结果', { exact: true })
      await receipts.focus()
      await page.keyboard.press('Enter')
      const states = await receipts.locator('..').innerText()
      assert(
        ['网页', '微信', '钉钉', '飞书'].every((channel) => states.includes(channel + '：已受理')),
      )
      facts.push({ visible, sources, ending: text.slice(-130), states })
    }
    proof.push({ viewport: size, facts })
    await page.close()
  }
  writeFileSync(join(output, 'browser-fidelity.json'), JSON.stringify(proof, null, 2))
} finally {
  await browser.close()
}
