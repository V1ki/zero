import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'
import type { RouterPublication, RouterPublicationTrace, RouterTraceRun } from '@zero-os/shared'

// Read existing deliveries through the running workbench. No callbacks, retries or replays.
const output = process.env.ZERO_ACCEPTANCE_OUTPUT
assert(output)
const base = 'http://localhost:3001'
const db = new Database('.zero/listeners/inbox.sqlite', { readonly: true })
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return url.origin === base && ['GET', 'HEAD'].includes(route.request().method())
      ? route.continue()
      : route.abort()
  })
  const res = await fetch(`${base}/api/listeners/router-publications`)
  assert(res.ok)
  const rows = (await res.json()) as (RouterPublication & {
    traceReceipts: RouterPublicationTrace[]
  })[]
  const published = rows.find(
    (p) =>
      p.traceReceipts?.length &&
      p.deliveries.length === 4 &&
      p.deliveries.every((d) => d.status === 'accepted') &&
      db.query('SELECT 1 FROM router_worker_links WHERE matter_id=?').get(p.matterId),
  )
  const failed = rows.find(
    (p) => p.traceReceipts?.length && p.deliveries.some((d) => d.status === 'rejected'),
  )
  assert(published && failed)
  const receipts = []
  for (const p of [failed, published]) {
    const ref = p.traceReceipts.find((t) => t.operation === 'publish_update')
    assert(ref)
    const path = `/router/traces?selected=${ref.runId}&entry=${ref.ordinal}`
    await page.goto(`${base}/router?view=notifications`)
    const link = page.locator(`a[href^="${path}"]`)
    await link.locator('xpath=ancestor::details/summary').click()
    await link.click()
    await expect(page.locator(`#trace-entry-${ref.ordinal} summary`)).toBeFocused()
    const detail = page.locator(`#trace-entry-${ref.ordinal}`)
    await expect(detail.getByText('本次调用返回的投递状态')).toBeVisible()
    const seen = JSON.parse(await detail.locator('pre').innerText())
    const receipt = JSON.parse(seen.result.output) as RouterPublication
    assert.equal(receipt.id, p.id)
    assert.deepEqual(
      receipt.deliveries.map((d) => d.channel).sort(),
      p.deliveries.map((d) => d.channel).sort(),
    )
    await page.getByRole('link', { name: '返回原阅读位置' }).click()
    const anchor = `rw-receipt-${ref.ordinal}`
    await expect(page.locator(`#${anchor}`)).toBeFocused()
    assert.equal(new URL(page.url()).hash, `#${anchor}`)
    receipts.push({
      publication: p.id,
      matter: p.matterId,
      ref,
      returnAnchor: anchor,
      channels: receipt.deliveries.map((d) => [d.channel, d.status]),
    })
  }
  await page.goto(`${base}/router?view=tasks&matterId=${published.matterId}`)
  const worker = page.getByRole('link', { name: /查看 Worker #.*的工作轨迹/ }).first()
  await worker.click()
  const workerUrl = page.url()
  await page.getByRole('link', { name: '返回这件跟进事项' }).click()
  await expect(page).toHaveURL(new RegExp(published.matterId))
  const samples = db
    .query<{ id: string; kind: string; matter: string | null }, []>(`WITH inputs AS (
    SELECT r.id,r.ordinal,CASE WHEN json_valid(json_extract(e.data,'$.prompt')) THEN json_extract(e.data,'$.prompt') END AS prompt
    FROM router_trace_runs r JOIN router_trace_entries e ON e.run_id=r.id AND e.kind='input' WHERE r.replay_of IS NULL)
    SELECT id,json_extract(prompt,'$.signal.kind') AS kind,json_extract(prompt,'$.matters.focusedMatter.id') AS matter
    FROM inputs WHERE kind IN ('ui_action','worker_result','event','timer') ORDER BY ordinal DESC`)
    .all()
  const signals = []
  for (const [kind, label] of [
    ['ui_action', '用户操作'],
    ['worker_result', 'Worker 返回结果'],
    ['event', '收到事件'],
    ['timer', '到期续办'],
  ]) {
    const sample = samples.find((s) => s.kind === kind && (kind !== 'ui_action' || s.matter))
    assert(sample)
    await page.goto(`${base}/router/traces?selected=${sample.id}`)
    await page.getByText(label, { exact: true }).click()
    await expect(page.locator('.rt-question')).toBeVisible()
    if (sample.matter) {
      const index = await fetch(
        `${base}/api/listeners/router-traces?matterId=${sample.matter}&runId=${sample.id}`,
      )
      assert(index.ok)
      const { items } = (await index.json()) as { items: RouterTraceRun[] }
      assert(items.some((r) => r.id === sample.id))
    }
    if (kind === 'worker_result') {
      const link = page.getByRole('link', { name: /查看 Worker #.*的运行记录/ })
      await link.click()
      await expect(page).toHaveURL(/sessionId=router-job-/)
    }
    signals.push(sample)
  }
  const capabilities = []
  for (const name of ['delegate_task', 'continue_task', 'present_ui']) {
    const result = db
      .query<{ runId: string; ordinal: number }, [string]>(
        "SELECT run_id AS runId, ordinal FROM router_trace_entries WHERE kind='tool_result' AND json_extract(data,'$.name')=? AND json_extract(data,'$.result.success')=1 ORDER BY ordinal DESC LIMIT 1",
      )
      .get(name)
    assert(result)
    await page.goto(`${base}/router/traces?selected=${result.runId}&entry=${result.ordinal}`)
    const entry = page.locator(`#trace-entry-${result.ordinal}`)
    await expect(entry.locator('summary')).toBeFocused()
    assert.equal(JSON.parse(await entry.locator('pre').innerText()).name, name)
    capabilities.push({ name, ...result })
  }
  const retries = db
    .query<{ session: string }, []>(
      "SELECT session_id AS session FROM router_trace_runs WHERE session_id LIKE 'router-job-%' GROUP BY session_id HAVING COUNT(DISTINCT status)>1 AND COUNT(*)>1 ORDER BY COUNT(*) DESC LIMIT 1",
    )
    .get()
  assert(retries)
  const response = await fetch(`${base}/api/listeners/router-traces?sessionId=${retries.session}`)
  assert(response.ok)
  const attempts = ((await response.json()) as { items: RouterTraceRun[] }).items
  assert(
    attempts.some((r) => r.status === 'completed') && attempts.some((r) => r.status === 'failed'),
  )
  writeFileSync(
    join(output, 'trace-navigation.json'),
    JSON.stringify(
      {
        receipts,
        workerUrl,
        signals,
        capabilities,
        workerAttempts: attempts.map((r) => ({
          id: r.id,
          status: r.status,
          startedAt: r.startedAt,
        })),
      },
      null,
      2,
    ),
  )
} finally {
  db.close()
  await browser.close()
}
