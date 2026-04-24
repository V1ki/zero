import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBuiltinRoles, loadRoles, resolveRole } from '../roles'

const TEMP_DIRS: string[] = []

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'zero-roles-test-'))
  TEMP_DIRS.push(root)
  mkdirSync(join(root, '.zero', 'roles'), { recursive: true })
  return root
}

describe('roles', () => {
  test('builtin roles match expected presets', () => {
    const roles = getBuiltinRoles()

    expect(Object.keys(roles).sort()).toEqual(['coder', 'explorer', 'reviewer'])
    expect(roles.explorer).toEqual({
      name: 'Explorer',
      agentInstruction:
        'You are an Explorer SubAgent for ZeRo OS. Research, investigate, and report findings. Be thorough and concise.',
      defaultTools: ['read', 'read_image', 'bash', 'fetch'],
    })
    expect(roles.coder).toEqual({
      name: 'Coder',
      agentInstruction:
        'You are a Coder SubAgent for ZeRo OS. Write, modify, and test code. Make minimal, correct changes. For multi-file refactors or complex code changes, prefer using the codex tool to delegate the work.',
      defaultTools: ['read', 'read_image', 'write', 'edit', 'bash', 'codex'],
    })
    expect(roles.reviewer).toEqual({
      name: 'Reviewer',
      agentInstruction:
        'You are a Reviewer SubAgent for ZeRo OS. Review code, identify bugs, and suggest improvements. Do not modify files.',
      defaultTools: ['read', 'read_image', 'bash'],
    })
  })

  test('loads file-based role from TOML', async () => {
    const root = createProjectRoot()
    writeFileSync(
      join(root, '.zero', 'roles', 'investigator.toml'),
      `name = "Investigator"
agent_instruction = "Investigate thoroughly and summarize."
default_tools = ["read", "fetch"]
model = "openai-codex/gpt-5.1-codex-mini"
prompt_mode = "minimal"
`,
    )

    const roles = await loadRoles(root)

    expect(roles.investigator).toEqual({
      name: 'Investigator',
      agentInstruction: 'Investigate thoroughly and summarize.',
      defaultTools: ['read', 'fetch'],
      model: 'openai-codex/gpt-5.1-codex-mini',
      promptMode: 'minimal',
    })
  })

  test('loads file-based role from YAML', async () => {
    const root = createProjectRoot()
    writeFileSync(
      join(root, '.zero', 'roles', 'planner.yaml'),
      `name: Planner
agent_instruction: Plan carefully and produce steps.
default_tools:
  - read
  - bash
prompt_mode: none
`,
    )

    const roles = await loadRoles(root)

    expect(roles.planner).toEqual({
      name: 'Planner',
      agentInstruction: 'Plan carefully and produce steps.',
      defaultTools: ['read', 'bash'],
      promptMode: 'none',
    })
  })

  test('file roles override same-named builtins', async () => {
    const root = createProjectRoot()
    writeFileSync(
      join(root, '.zero', 'roles', 'explorer.yaml'),
      `name: Explorer Override
agent_instruction: Explore with a different model.
default_tools:
  - read
model: openai-codex/gpt-5.1-codex-mini
`,
    )

    const roles = await loadRoles(root)

    expect(roles.explorer).toEqual({
      name: 'Explorer Override',
      agentInstruction: 'Explore with a different model.',
      defaultTools: ['read'],
      model: 'openai-codex/gpt-5.1-codex-mini',
      promptMode: 'minimal',
    })
  })

  test('invalid role files are skipped with warning', async () => {
    const root = createProjectRoot()
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      writeFileSync(
        join(root, '.zero', 'roles', 'broken.yaml'),
        `name: Broken
default_tools: invalid
`,
      )

      const roles = await loadRoles(root)
      expect(roles.broken).toBeUndefined()
      expect(warnings.length).toBeGreaterThan(0)
    } finally {
      console.warn = originalWarn
    }
  })

  test('unknown role returns undefined', () => {
    expect(resolveRole('missing', getBuiltinRoles())).toBeUndefined()
  })

  test('role with model override is preserved', async () => {
    const root = createProjectRoot()
    writeFileSync(
      join(root, '.zero', 'roles', 'reviewer.toml'),
      `model = "openai-codex/gpt-5.1-codex-mini"
`,
    )

    const roles = await loadRoles(root)

    expect(roles.reviewer?.model).toBe('openai-codex/gpt-5.1-codex-mini')
    expect(roles.reviewer?.agentInstruction).toBe(
      'You are a Reviewer SubAgent for ZeRo OS. Review code, identify bugs, and suggest improvements. Do not modify files.',
    )
    expect(roles.reviewer?.defaultTools).toEqual(['read', 'read_image', 'bash'])
  })
})
