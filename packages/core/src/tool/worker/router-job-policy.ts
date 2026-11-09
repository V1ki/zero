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

/** Use the operator's current Codex policy, including on resume of older Router threads. */
export async function routerJobPolicy(connection: CodexWorkerConnection, cwd: string) {
  const { config } = await connection.request('config/read', { cwd })
  const settings = object(config)
  return {
    ...(typeof settings.approval_policy === 'string' && {
      approvalPolicy: settings.approval_policy,
    }),
    ...(typeof settings.default_permissions === 'string'
      ? { permissions: settings.default_permissions, runtimeWorkspaceRoots: [cwd] }
      : typeof settings.sandbox_mode === 'string'
        ? { sandbox: settings.sandbox_mode }
        : {}),
  }
}

export function verifyRouterJobPolicy(thread: Fields, cwd: string) {
  if (thread.cwd !== cwd)
    throw new RouterCodexError('Codex 返回的工作区与已授权的任务工作区不一致。', false)
}
