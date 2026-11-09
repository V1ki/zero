import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const directory = new URL('../../docs/', import.meta.url)
const file = fileURLToPath(new URL('router-acceptance.html', directory))
const spec = JSON.parse(readFileSync(new URL('router-acceptance.json', directory), 'utf8')) as {
  requirements: { id: string; priority: string }[]
}
const report = JSON.parse(
  readFileSync(new URL('router-validation-v03.json', directory), 'utf8'),
) as {
  updatedAt: string
  evidence: Record<string, unknown>
  requirements: { id: string; priority: string; status: string; remaining: string; evidenceGroup: string }[]
}
assert.equal(
  new Set(spec.requirements.map((r) => r.id)).size,
  spec.requirements.length,
  'Duplicate acceptance id',
)
assert.deepEqual(
  spec.requirements.map(({ id, priority }) => ({ id, priority })),
  report.requirements.map(({ id, priority }) => ({ id, priority })),
)
const content = readFileSync(file, 'utf8')
const summary = {
  updatedAt: report.updatedAt,
  pendingRequired: report.requirements
    .filter((r) => r.priority !== 'bonus' && r.status !== '通过')
    .map((r) => r.id),
  items: report.requirements.map(({ id, status, remaining }) => ({ id, status, remaining })),
}
for (const item of report.requirements) {
  assert(item.status.trim() && item.remaining.trim(), 'Missing result for ' + item.id)
  assert(Object.hasOwn(report.evidence, item.evidenceGroup), 'Missing evidence group for ' + item.id)
}
let updated = content
for (const [id, data] of [
  ['spec', spec],
  ['progress', summary],
] as const) {
  const pattern = new RegExp(`(<script id="${id}" type="application/json">)[\\s\\S]*?(</script>)`)
  assert(pattern.test(updated), 'Missing ' + id)
  updated = updated.replace(
    pattern,
    (_, opening, closing) => opening + JSON.stringify(data).replaceAll('<', '\\u003c') + closing,
  )
}
if (process.argv.includes('--check'))
  assert.equal(
    content === updated,
    true,
    'Run bun benchmarks/router-v03/sync-report.ts to update the standalone report',
  )
else writeFileSync(file, updated)
