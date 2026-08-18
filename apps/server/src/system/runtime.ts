import { spawn, spawnSync } from 'node:child_process'
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

/**
 * Build the web bundle without blocking the server event loop. This is used by
 * the in-chat restart command so heartbeat and lock ownership remain live
 * during a slow Vite build.
 */
export function rebuildWebBundleAsync(): Promise<WebBuildResult> {
  return new Promise((resolve) => {
    const child = spawn(getBunExecutable(), ['run', 'build'], {
      cwd: join(process.cwd(), 'apps/web'),
      env: getRuntimeEnv(),
      stdio: 'inherit',
    })
    let settled = false
    const finish = (result: WebBuildResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    child.once('error', (error) => {
      finish({ ok: false, error: error.message })
    })
    child.once('exit', (code, signal) => {
      finish(
        code === 0
          ? { ok: true }
          : {
              ok: false,
              error:
                code !== null
                  ? `build:web exited with code ${code}`
                  : `build:web exited from signal ${signal ?? 'unknown'}`,
            },
      )
    })
  })
}
