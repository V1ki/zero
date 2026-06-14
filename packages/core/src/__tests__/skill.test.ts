import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSkillCatalog } from '../agent/prompt'
import { loadSkills } from '../skill'

const TEST_DIR = join(import.meta.dir, '__fixtures__', 'skills')

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

beforeAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'browser'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'empty-dir'), { recursive: true })

  writeFileSync(
    join(TEST_DIR, 'browser', 'SKILL.md'),
    `---
name: browser
description: |
  通过 agent-browser CLI 控制浏览器。
  触发词：浏览器、打开网页、截图。
allowed-tools:
  - bash
---

# Browser Skill

通过 agent-browser CLI 控制 CDP 浏览器。

## Core Workflow

1. Navigate — \`agent-browser open <url>\`
2. Snapshot — \`agent-browser snapshot -i\`
`,
  )
})

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
})

describe('loadSkills', () => {
  it('loads skills from directory', () => {
    const skills = loadSkills(TEST_DIR)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('browser')
    expect(skills[0].allowedTools).toEqual(['bash'])
    expect(skills[0].content).toContain('# Browser Skill')
    expect(skills[0].description).toContain('agent-browser CLI')
  })

  it('includes sourcePath pointing to SKILL.md', () => {
    const skills = loadSkills(TEST_DIR)
    expect(skills[0].sourcePath).toBe(join(TEST_DIR, 'browser', 'SKILL.md'))
  })

  it('returns empty array for non-existent directory', () => {
    const skills = loadSkills('/tmp/non-existent-skills-dir')
    expect(skills).toEqual([])
  })

  it('skips subdirectories without SKILL.md', () => {
    const skills = loadSkills(TEST_DIR)
    // empty-dir has no SKILL.md, should be skipped
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('browser')
  })

  it('uses directory name as fallback when frontmatter has no name', () => {
    mkdirSync(join(TEST_DIR, 'noname'), { recursive: true })
    writeFileSync(
      join(TEST_DIR, 'noname', 'SKILL.md'),
      `---
description: A skill without a name field.
allowed-tools:
  - read
---

# No Name Skill

This skill has no name in frontmatter.
`,
    )
    const skills = loadSkills(TEST_DIR)
    const noname = expectDefined(skills.find((s) => s.name === 'noname'))
    expect(noname.allowedTools).toEqual(['read'])
    expect(noname.sourcePath).toBe(join(TEST_DIR, 'noname', 'SKILL.md'))

    rmSync(join(TEST_DIR, 'noname'), { recursive: true })
  })

  it('handles missing allowed-tools gracefully', () => {
    mkdirSync(join(TEST_DIR, 'minimal'), { recursive: true })
    writeFileSync(
      join(TEST_DIR, 'minimal', 'SKILL.md'),
      `---
name: minimal
---

Minimal skill.
`,
    )
    const skills = loadSkills(TEST_DIR)
    const minimal = expectDefined(skills.find((s) => s.name === 'minimal'))
    expect(minimal.allowedTools).toEqual([])
    expect(minimal.description).toBe('')

    rmSync(join(TEST_DIR, 'minimal'), { recursive: true })
  })
})

describe('buildSkillCatalog', () => {
  it('renders skill metadata without full content', () => {
    const skills = loadSkills(TEST_DIR)
    const catalog = buildSkillCatalog(skills)

    expect(catalog).toContain('<skill_catalog>')
    expect(catalog).toContain('</skill_catalog>')
    expect(catalog).toContain('name="browser"')
    expect(catalog).toContain(`path="${join(TEST_DIR, 'browser', 'SKILL.md')}"`)
    expect(catalog).toContain('agent-browser CLI')
    // Should NOT contain the full SKILL.md content
    expect(catalog).not.toContain('# Browser Skill')
    expect(catalog).not.toContain('agent-browser open')
  })
})
