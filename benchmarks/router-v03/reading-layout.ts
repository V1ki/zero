// Exercise the workbench reader with a known long body and a real, already delivered Web surface.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { Database } from 'bun:sqlite'

const out = process.env.ZERO_ACCEPTANCE_OUTPUT
assert(out)
mkdirSync(out, { recursive: true })
const db = new Database(join(process.cwd(), '.zero/listeners/inbox.sqlite'), { readonly: true })
const record = db
  .query<
    { id: string; matterId: string; scope: string; createdAt: string; presentation: string },
    []
  >(
    "SELECT p.id,p.matter_id AS matterId,p.scope,p.created_at AS createdAt,d.presentation FROM router_publications p JOIN router_publication_deliveries d ON d.publication_id=p.id WHERE p.matter_id='00642d85-deb4-4e31-9b38-5ac29cac4f7e' AND d.channel='web' AND d.status='accepted' AND json_type(d.presentation,'$.generatedUI')='object' ORDER BY created_at DESC LIMIT 1",
  )
  .get()
db.close()
assert(record)
const original = JSON.parse(record.presentation)
const url = 'https://github.com/V1ki/dsh-plugin-subscriptions/pull/197'
const facts = [
  '#145 文档说明',
  '#163 空回复',
  '#162 模型速度',
  '#185 存储兼容',
  '#185 重试等待',
  '#165 型号名称',
  '#189 图片输出',
  '#188 额度评分',
]
const command =
  'git diff --stat cac7bb3f4eaa796114a941380b067ced6decbd03 8193df1b1c3ed52715671946ca2fe96cdbcb8472'
const markdown = [
  original.text,
  '### 已审内容',
  facts.map((f) => '- ' + f).join('\n'),
  '### 在哪个版本验证',
  '| 改动 | 已审提交 | 本地测试 |\n|---|---|---|\n| #189 | 7bc7fa6b894994d69b67be54a3e9f36c6bd1bb3c | 750/750 |\n| #197 | f03ec8e1313c611030a4774ea07b84fab14e522e | 759/759 |',
  '查看两次合并之间的差异可用以下命令。',
  '\x60\x60\x60sh\n' + command + '\n\x60\x60\x60',
  '这些数字是本地测试结果。[查看 #197 的改动和验证记录](' + url + ')',
].join('\n\n')
const fixture = {
  ...record,
  deliveries: [
    { channel: 'web', status: 'accepted', presentation: { ...original, text: markdown } },
  ],
}
writeFileSync(join(out, 'expected.md'), markdown)
const browser = await chromium.launch()
try {
  const observations = []
  for (const size of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    const page = await browser.newPage({ viewport: size })
    await page.route('**/api/listeners/router-publications*', (route) =>
      route.fulfill({ json: [fixture] }),
    )
    await page.goto('http://localhost:3001/router?view=notifications#rw-publication-' + record.id)
    const row = page.locator('#rw-publication-' + record.id)
    await expect(row).toBeFocused()
    const summary = row.getByText('完整文字与证据链接', { exact: true })
    await summary.focus()
    await page.keyboard.press('Enter')
    const detail = summary.locator('..')
    await expect(detail).toHaveAttribute('open', '')
    for (const fact of facts) await expect(detail.getByText(fact, { exact: true })).toBeVisible()
    const table = detail.getByRole('table').last()
    await expect(table.getByRole('row')).toHaveCount(3)
    const code = detail.locator('pre').last()
    await expect(code).toHaveText(command + '\n')
    await code.focus()
    await page.keyboard.press('End')
    await expect(code).toBeFocused()
    const link = detail.getByRole('link', { name: '查看 #197 的改动和验证记录' })
    await expect(link).toHaveAttribute('href', url)
    await link.focus()
    await expect(link).toBeFocused()
    await row.screenshot({ path: join(out, 'reading-' + size.width + '.png') })
    const widths = await page.evaluate(() => ({
      body: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }))
    assert(widths.body <= widths.viewport, 'Horizontal overflow outside the code/table regions')
    observations.push({
      size,
      widths,
      tableRows: await table.innerText(),
      code: await code.innerText(),
      link: await link.getAttribute('href'),
      ending: (await detail.innerText()).slice(-110),
    })
    await page.close()
  }
  writeFileSync(join(out, 'layout.json'), JSON.stringify(observations, null, 2))
} finally {
  await browser.close()
}
