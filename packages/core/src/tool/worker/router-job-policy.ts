import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { CodexWorkerConnection } from './codex-worker-server'

type Fields = Record<string, unknown>
const object = (value: unknown): Fields => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Codex configuration or permissions')
  return value as Fields
}

export class RouterCodexError extends Error {
  constructor(
    message: string,
    readonly outcomeUnknown: boolean,
  ) {
    super(message)
  }
}

/** Named permissions confine reads as well as writes. Legacy workspace-write allows host reads. */
export async function routerJobPolicy(connection: CodexWorkerConnection, cwd: string) {
  const { config } = await connection.request('config/read', { cwd })
  const settings = object(config)
  // Codex merges individual map entries across layers. Disable inherited servers by name
  // and blank inherited shell overrides before supplying the worker's command search path.
  const servers = Object.keys(object(settings.mcp_servers ?? {}))
  const envKeys = Object.keys(object(object(settings.shell_environment_policy ?? {}).set ?? {}))
  const profile = `zero-router-${randomUUID()}`
  const features = {
    apps: false,
    plugins: false,
    remote_plugin: false,
    hooks: false,
    memories: false,
    computer_use: false,
    browser_use: false,
    in_app_browser: false,
    multi_agent: false,
    multi_agent_v2: false,
    goals: false,
    code_mode: false,
    code_mode_host: false,
    image_generation: false,
    skill_search: false,
    skip_host_skill_discovery: true,
  }
  return {
    permissions: profile,
    runtimeWorkspaceRoots: [cwd],
    config: {
      default_permissions: profile,
      permissions: {
        [profile]: {
          filesystem: {
            ':minimal': 'read',
            ':workspace_roots': 'write',
            [join(cwd, '.git')]: 'read',
            [join(cwd, '.zero')]: 'deny',
            [join(cwd, '.codex')]: 'deny',
          },
          network: { enabled: false },
        },
      },
      features,
      web_search: 'disabled',
      notify: [],
      allow_login_shell: false,
      shell_environment_policy: {
        inherit: 'none',
        experimental_use_profile: false,
        set: {
          ...Object.fromEntries(envKeys.map((key) => [key, ''])),
          PATH: process.env.PATH ?? '/usr/bin:/bin',
        },
      },
      mcp_servers: Object.fromEntries(servers.map((name) => [name, { enabled: false }])),
      skills: { include_instructions: false, bundled: { enabled: false } },
    },
  }
}

export async function verifyRouterJobPolicy(
  connection: CodexWorkerConnection,
  thread: Fields,
  id: string,
  cwd: string,
  permissions: string,
) {
  const sandbox = object(thread.sandbox)
  if (
    object(thread.activePermissionProfile).id !== permissions ||
    thread.cwd !== cwd ||
    thread.approvalPolicy !== 'never' ||
    !Array.isArray(thread.runtimeWorkspaceRoots) ||
    thread.runtimeWorkspaceRoots.length !== 1 ||
    thread.runtimeWorkspaceRoots[0] !== cwd ||
    sandbox.type !== 'workspaceWrite' ||
    sandbox.networkAccess !== false ||
    sandbox.excludeTmpdirEnvVar !== true ||
    sandbox.excludeSlashTmp !== true ||
    !Array.isArray(sandbox.writableRoots) ||
    sandbox.writableRoots.some((root) => root !== cwd)
  )
    throw new RouterCodexError('Codex 未确认此任务的工作区隔离策略，任务未启动。', false)
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const page = await connection.request('mcpServerStatus/list', {
      threadId: id,
      limit: 100,
      detail: 'toolsAndAuthOnly',
      ...(cursor && { cursor }),
    })
    if (
      !Array.isArray(page.data) ||
      page.data.some((row) => object(row).runtimeStatus !== 'disabled')
    )
      throw new RouterCodexError('Codex 仍有外部工具可用，任务未启动。', false)
    if (page.nextCursor == null) return
    if (typeof page.nextCursor !== 'string' || !page.nextCursor || seen.has(page.nextCursor))
      throw new Error('Invalid Codex external tool inventory')
    cursor = page.nextCursor
    seen.add(cursor)
  } while (cursor)
}
