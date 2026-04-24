import { existsSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { readYaml, toErrorMessage } from '@zero-os/shared'
import type { PromptMode } from '@zero-os/shared'
import { readString, readStringArray } from '../utils/yaml'

export interface RoleDefinition {
  name: string
  agentInstruction: string
  defaultTools: string[]
  model?: string
  promptMode?: PromptMode
}

const BUILTIN_ROLES: Record<string, RoleDefinition> = {
  explorer: {
    name: 'Explorer',
    agentInstruction:
      'You are an Explorer SubAgent for ZeRo OS. Research, investigate, and report findings. Be thorough and concise.',
    defaultTools: ['read', 'read_image', 'bash', 'fetch'],
  },
  coder: {
    name: 'Coder',
    agentInstruction:
      'You are a Coder SubAgent for ZeRo OS. Write, modify, and test code. Make minimal, correct changes. For multi-file refactors or complex code changes, prefer using the codex tool to delegate the work.',
    defaultTools: ['read', 'read_image', 'write', 'edit', 'bash', 'codex'],
  },
  reviewer: {
    name: 'Reviewer',
    agentInstruction:
      'You are a Reviewer SubAgent for ZeRo OS. Review code, identify bugs, and suggest improvements. Do not modify files.',
    defaultTools: ['read', 'read_image', 'bash'],
  },
}

const ROLE_CACHE = new Map<string, Record<string, RoleDefinition>>()

export async function loadRoles(projectRoot: string): Promise<Record<string, RoleDefinition>> {
  const cached = ROLE_CACHE.get(projectRoot)
  if (cached) return cloneRoles(cached)

  const roles: Record<string, RoleDefinition> = getBuiltinRoles()
  const rolesDir = join(projectRoot, '.zero', 'roles')

  if (!existsSync(rolesDir)) {
    ROLE_CACHE.set(projectRoot, cloneRoles(roles))
    return cloneRoles(roles)
  }

  const files = readdirSync(rolesDir)
    .filter((file) => ['.toml', '.yaml', '.yml'].includes(extname(file).toLowerCase()))
    .sort()

  for (const file of files) {
    const filePath = join(rolesDir, file)
    const roleId = basename(file, extname(file))

    try {
      const raw = await parseRoleFile(filePath)
      const normalized = normalizeRoleDefinition(raw, roleId, roles[roleId])
      if (!normalized) {
        console.warn(`[roles] Skipping invalid role file: ${filePath}`)
        continue
      }
      roles[roleId] = normalized
    } catch (error) {
      console.warn(`[roles] Failed to load role file: ${filePath}`, {
        message: toErrorMessage(error),
      })
    }
  }

  ROLE_CACHE.set(projectRoot, cloneRoles(roles))
  return cloneRoles(roles)
}

export function resolveRole(
  roleId: string,
  roles: Record<string, RoleDefinition>,
): RoleDefinition | undefined {
  const role = roles[roleId]
  return role ? cloneRole(role) : undefined
}

export function getBuiltinRoles(): Record<string, RoleDefinition> {
  return cloneRoles(BUILTIN_ROLES)
}

async function parseRoleFile(filePath: string): Promise<Record<string, unknown>> {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.toml') {
    const content = await Bun.file(filePath).text()
    return Bun.TOML.parse(content) as Record<string, unknown>
  }

  return readYaml<Record<string, unknown>>(filePath)
}

function normalizeRoleDefinition(
  raw: Record<string, unknown>,
  roleId: string,
  baseRole?: RoleDefinition,
): RoleDefinition | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }

  const name = readString(raw, 'name') ?? baseRole?.name ?? humanizeRoleId(roleId)
  const agentInstruction =
    readString(raw, 'agentInstruction', 'agent_instruction') ?? baseRole?.agentInstruction
  const defaultTools =
    readStringArray(raw, 'defaultTools', 'default_tools') ?? baseRole?.defaultTools
  const model = readString(raw, 'model') ?? baseRole?.model
  const promptMode =
    readPromptMode(raw, 'promptMode', 'prompt_mode') ?? baseRole?.promptMode ?? 'minimal'

  if (!agentInstruction || !defaultTools) {
    return undefined
  }

  return {
    name,
    agentInstruction,
    defaultTools: [...defaultTools],
    ...(model ? { model } : {}),
    promptMode,
  }
}

function readPromptMode(raw: Record<string, unknown>, ...keys: string[]): PromptMode | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (value === 'full' || value === 'minimal' || value === 'none') {
      return value
    }
    if (value !== undefined) {
      return undefined
    }
  }
  return undefined
}

function humanizeRoleId(roleId: string): string {
  return roleId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function cloneRole(role: RoleDefinition): RoleDefinition {
  return {
    ...role,
    defaultTools: [...role.defaultTools],
  }
}

function cloneRoles(roles: Record<string, RoleDefinition>): Record<string, RoleDefinition> {
  return Object.fromEntries(Object.entries(roles).map(([id, role]) => [id, cloneRole(role)]))
}
