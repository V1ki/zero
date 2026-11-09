// Exercise a previously used IM card from the other, now stale, Web entrypoint.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { chromium, expect } from '@playwright/test'
const output = process.env.ZERO_ACCEPTANCE_OUTPUT
const id = process.env.ZERO_ACCEPTANCE_PUBLICATION
assert(output && id && /^[a-f0-9]{64}$/.test(id))
const db = new Database('.zero/listeners/inbox.sqlite', { readonly: true })
const get = () =>
  db
    .query<{ original: number; current: number; state: string; matter: string }, [string]>(
      'SELECT p.matter_version AS original,m.version AS current,m.state,p.matter_id AS matter FROM router_publications p JOIN router_matters m ON m.id=p.matter_id WHERE p.id=?',
    )
    .get(id)
const actions = () =>
  db
    .query(
      "SELECT count(*) AS actions FROM router_signals WHERE kind='ui_action' AND json_extract(payload,'$.publicationId')=?",
    )
    .get(id)
const before = get(),
  signals = actions()
assert(before && before.current > before.original)
const reader = db
  .query<{ id: number; state: string; channel: string; action: string }, [string]>(
    "SELECT id,state,json_extract(payload,'$.actor.platform') AS channel,json_extract(payload,'$.actionId') AS action FROM router_signals WHERE kind='ui_action' AND json_extract(payload,'$.publicationId')=? AND state='completed'",
  )
  .get(id)
assert(reader && reader.channel)
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto('http://localhost:3001/router?view=notifications#rw-publication-' + id)
  const row = page.locator('#rw-publication-' + id)
  await expect(row).toBeFocused()
  const button = row.locator('.router-a2ui button').first()
  const label = await button.innerText()
  const result = page.waitForResponse((r) =>
    r.url().endsWith('/router-publications/' + id + '/actions'),
  )
  await button.click()
  const response = await result
  assert.equal(response.status(), 409)
  const reason = await response.json()
  assert.deepEqual(get(), before)
  assert.deepEqual(actions(), signals)
  await expect(
    page.getByRole('alert').filter({ hasText: '事项或来源授权已变化' }).first(),
  ).toBeVisible()
  await Bun.write(
    join(output, 'receipt.json'),
    JSON.stringify(
      { id, reader, label, before, signals, after: get(), http: response.status(), reason },
      null,
      2,
    ),
  )
} finally {
  db.close()
  await browser.close()
}
