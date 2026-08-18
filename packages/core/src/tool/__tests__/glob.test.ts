import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@zero-os/shared'
import { GlobTool } from '../glob'

const testDir = join(tmpdir(), `zero-glob-tool-test-${process.pid}`)

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
  mkdirSync(join(testDir, 'x'), { recursive: true })
  mkdirSync(join(testDir, 'y'), { recursive: true })
  mkdirSync(join(testDir, 'node_modules'), { recursive: true })
  writeFileSync(join(testDir, 'x', 'one.ts'), 'export const one = 1\n')
  writeFileSync(join(testDir, 'x', 'two.ts'), 'export const two = 2\n')
  writeFileSync(join(testDir, 'y', 'readme.md'), '# readme\n')
  writeFileSync(join(testDir, 'node_modules', 'skip.ts'), 'should be excluded\n')

  // Make two.ts clearly older so mtime ordering is deterministic.
  const older = new Date('2020-01-01T00:00:00Z')
  utimesSync(join(testDir, 'x', 'two.ts'), older, older)
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('GlobTool', () => {
  const tool = new GlobTool()

  test('finds files recursively and sorts newest first', async () => {
    const result = await tool.run(makeCtx(), { pattern: '*.ts' })
    expect(result.success).toBe(true)
    const lines = result.output.split('\n').filter(Boolean)
    expect(lines).toEqual(['x/one.ts', 'x/two.ts'])
  })

  test('excludes node_modules by default', async () => {
    const result = await tool.run(makeCtx(), { pattern: '*.ts' })
    expect(result.output).not.toContain('node_modules')
  })

  test('caps results and appends an omission note', async () => {
    const result = await tool.run(makeCtx(), { pattern: '*.ts', maxResults: 1 })
    expect(result.success).toBe(true)
    expect(result.output).toContain('x/one.ts')
    expect(result.output).toContain('1 more matched files omitted')
  })

  test('resolves relative base path against the workspace', async () => {
    const result = await tool.run(makeCtx(), { pattern: '*.md', path: 'y' })
    expect(result.success).toBe(true)
    expect(result.output.split('\n')[0]).toBe('readme.md')
  })

  test('no matches is a successful empty result', async () => {
    const result = await tool.run(makeCtx(), { pattern: '*.rs' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('No files matched')
  })
})
