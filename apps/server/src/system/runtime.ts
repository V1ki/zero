import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

export function getBunExecutable() {
  return process.execPath
}

export function getRuntimeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const bunDir = dirname(getBunExecutable())
  const pathValue = env.PATH ? `${bunDir}:${env.PATH}` : bunDir

  return {
    ...env,
    PATH: pathValue,
  }
}

export interface WebBuildResult {
  ok: boolean
  error?: string
}

export function rebuildWebBundle(): WebBuildResult {
  const result = spawnSync(getBunExecutable(), ['run', 'build'], {
    cwd: join(process.cwd(), 'apps/web'),
    env: getRuntimeEnv(),
    stdio: 'inherit',
  })

  if (result.status === 0) {
    return { ok: true }
  }

  return {
    ok: false,
    error: result.error?.message ?? `build:web exited with code ${result.status ?? 'unknown'}`,
  }
}
