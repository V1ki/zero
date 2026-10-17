import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasSoulFile, loadBootstrapFiles } from '../loader'
import { BOOTSTRAP_FILE_NAMES, DEFAULT_TEMPLATES } from '../templates'

const TEST_DIR = join(import.meta.dir, '__test_workspace__')
const WORKSPACE_DIR = join(TEST_DIR, 'workspace')

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

beforeAll(() => {
  mkdirSync(WORKSPACE_DIR, { recursive: true })
})

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
})

describe('loadBootstrapFiles', () => {
  test('returns default templates when no files exist on disk', () => {
    const emptyWorkspace = join(TEST_DIR, 'empty_workspace')
    mkdirSync(emptyWorkspace, { recursive: true })

    const files = loadBootstrapFiles(emptyWorkspace)

    expect(files.length).toBe(BOOTSTRAP_FILE_NAMES.length)
    expect(files[0].name).toBe('SOUL.md')
    expect(files[0].content).toBe(DEFAULT_TEMPLATES['SOUL.md'])
    expect(files[1].name).toBe('USER.md')
    expect(files[2].name).toBe('TOOLS.md')
  })

  test('default persona contains style only, without self-edit or memory instructions', () => {
    const soul = DEFAULT_TEMPLATES['SOUL.md']

    expect(soul).toContain('人格与语气')
    expect(soul).toContain('保持独立判断')
    expect(soul).not.toContain('update it')
    expect(soul).not.toContain('memory files')
    expect(soul).not.toContain('ask before acting externally')
  })

  test('loads custom files from workspace directory', () => {
    const customContent = '# Custom Soul\n\nI am unique.'
    writeFileSync(join(WORKSPACE_DIR, 'SOUL.md'), customContent)

    const files = loadBootstrapFiles(WORKSPACE_DIR)
    const soul = expectDefined(files.find((f) => f.name === 'SOUL.md'))

    expect(soul.content).toBe(customContent)
    expect(soul.path).toBe(join(WORKSPACE_DIR, 'SOUL.md'))

    // Other files should still get defaults
    const user = expectDefined(files.find((f) => f.name === 'USER.md'))
    expect(user.content).toContain('User Profile')
  })

  test('truncates files exceeding per-file size limit', () => {
    const largeContent = 'x'.repeat(25_000)
    writeFileSync(join(WORKSPACE_DIR, 'TOOLS.md'), largeContent)

    const files = loadBootstrapFiles(WORKSPACE_DIR)
    const tools = expectDefined(files.find((f) => f.name === 'TOOLS.md'))

    expect(tools.content.length).toBeLessThan(largeContent.length)
    expect(tools.content).toContain('truncated')
  })

  test('returns empty array for none mode', () => {
    const files = loadBootstrapFiles(WORKSPACE_DIR, 'none')
    expect(files.length).toBe(0)
  })

  test('filters to TOOLS.md only for minimal mode', () => {
    const files = loadBootstrapFiles(WORKSPACE_DIR, 'minimal')

    expect(files.length).toBe(1)
    expect(files.map((f) => f.name)).toEqual(['TOOLS.md'])
  })

  test('returns all files for full mode', () => {
    const files = loadBootstrapFiles(WORKSPACE_DIR, 'full')

    expect(files.length).toBe(BOOTSTRAP_FILE_NAMES.length)
  })

  test('does not contain AGENTS.md in bootstrap files', () => {
    expect(BOOTSTRAP_FILE_NAMES).not.toContain('AGENTS.md')
  })

  test('default templates do not instruct agent to read SOUL.md', () => {
    for (const content of Object.values(DEFAULT_TEMPLATES)) {
      expect(content).not.toContain('Read SOUL.md')
    }
  })
})

describe('hasSoulFile', () => {
  test('returns true when SOUL.md has content', () => {
    const files = [{ name: 'SOUL.md', path: '/p', content: '# Soul' }]
    expect(hasSoulFile(files)).toBe(true)
  })

  test('returns false when SOUL.md is empty', () => {
    const files = [{ name: 'SOUL.md', path: '/p', content: '   ' }]
    expect(hasSoulFile(files)).toBe(false)
  })

  test('returns false when no SOUL.md present', () => {
    const files = [{ name: 'TOOLS.md', path: '/p', content: '# Tools' }]
    expect(hasSoulFile(files)).toBe(false)
  })
})
