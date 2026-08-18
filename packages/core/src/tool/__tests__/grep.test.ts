import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@zero-os/shared'
import { GrepTool } from '../grep'

const testDir = join(tmpdir(), `zero-grep-tool-test-${process.pid}`)

const makeCtx = () =>
  ({
    sessionId: 'test_session',
    workDir: testDir,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  }) as unknown as ToolContext

beforeAll(() => {
  mkdirSync(join(testDir, 'sub'), { recursive: true })
  writeFileSync(join(testDir, 'alpha.ts'), 'const alpha = 1\nconst beta = 2\n')
  writeFileSync(join(testDir, 'sub', 'notes.md'), 'alpha note\n')
  writeFileSync(join(testDir, 'huge.jsonl'), `{"needle":"${'x'.repeat(100_000)}"}\n`)
  writeFileSync(
    join(testDir, 'many.txt'),
    Array.from({ length: 100 }, (_, i) => `match-${i}`).join('\n'),
  )
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('GrepTool', () => {
  const tool = new GrepTool()

  test('content mode returns file, line number and matching text', async () => {
    const result = await tool.run(makeCtx(), { pattern: 'alpha' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('alpha.ts:1:const alpha = 1')
    expect(result.output).toContain('notes.md')
  })

  test('huge single-line files are clipped instead of dumped', async () => {
    const result = await tool.run(makeCtx(), { pattern: 'needle' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('huge.jsonl')
    expect(result.output.length).toBeLessThan(5_000)
  })

  test('caps result lines and appends a truncation note', async () => {
    const result = await tool.run(makeCtx(), { pattern: 'match-', maxResults: 10 })
    expect(result.success).toBe(true)
    const matchLines = result.output.split('\n').filter((line) => line.includes('many.txt'))
    expect(matchLines.length).toBe(10)
    expect(result.output).toContain('results capped at 10 lines')
    expect(result.outputSummary).toContain('capped')
  })

  test('files mode lists only file paths', async () => {
    const result = await tool.run(makeCtx(), { pattern: 'alpha', mode: 'files' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('alpha.ts')
    expect(result.output).toContain('notes.md')
    expect(result.output).not.toContain(':1:')
  })

  test('count mode sums matches across files', async () => {
    const result = await tool.run(makeCtx(), { pattern: 'const', mode: 'count' })
    expect(result.success).toBe(true)
    expect(result.outputSummary).toBe('Found 2 matches across 1 files')
  })

  test('no matches is a successful empty result', async () => {
    const result = await tool.run(makeCtx(), { pattern: 'zzz_definitely_not_there' })
    expect(result.success).toBe(true)
    expect(result.output).toBe('No matches found.')
  })

  test('glob filter narrows the searched files', async () => {
    const result = await tool.run(makeCtx(), { pattern: 'alpha', glob: '*.md' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('notes.md')
    expect(result.output).not.toContain('alpha.ts')
  })
})
