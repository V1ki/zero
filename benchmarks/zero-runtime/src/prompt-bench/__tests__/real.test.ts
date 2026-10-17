import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRealSuite } from '../real'
import { hasObviousShellWrite } from '../sandbox'

test('quoted read-only program operators are not shell writes; shell writes remain visible', () => {
  expect(
    hasObviousShellWrite("bun -e 'const ok = xs.every((s,i)=>s===xs[i%k]); console.log(ok)'"),
  ).toBe(false)
  expect(hasObviousShellWrite('bun -e "console.log(2 > 1)"')).toBe(false)
  expect(hasObviousShellWrite('echo value > /benchmark/other.json')).toBe(true)
  expect(hasObviousShellWrite('echo "safe"; rm /benchmark/notes.md')).toBe(true)
})

test('real replay rejects changed input data instead of silently comparing different material', () => {
  const dir = mkdtempSync(join(tmpdir(), 'real-replay-'))
  try {
    const raw = JSON.stringify({ schema: 1, agent: [], closure: [], provenance: [] })
    writeFileSync(join(dir, 'suite.json'), raw)
    const manifest = join(dir, 'manifest.json')
    writeFileSync(
      manifest,
      JSON.stringify({
        file: 'suite.json',
        sha256: createHash('sha256').update(raw).digest('hex'),
      }),
    )
    expect(readRealSuite(manifest).schema).toBe(1)
    writeFileSync(join(dir, 'suite.json'), raw.replace('"agent":[]', '"agent":[{}]'))
    expect(() => readRealSuite(manifest)).toThrow('Frozen real-task inputs changed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
