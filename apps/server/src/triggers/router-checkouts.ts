import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { CommissionOperator, RouterCodexCheckout } from '@zero-os/shared'

const run = promisify(execFile)

function contains(parent: string, child: string) {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function gitReadOnly(cwd: string, args: string[]) {
  // The two fixed commands inspect local metadata. No shell, network, pager, filters or hooks.
  const result = await run('git', ['--no-pager', ...args], {
    cwd,
    env: {
      PATH: (process.env.PATH ?? '')
        .split(delimiter)
        .filter((entry) => isAbsolute(entry) && !contains(cwd, entry))
        .join(delimiter),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    },
    timeout: 3000,
    maxBuffer: 8192,
  })
  return result.stdout
}

export function createRouterCheckoutResolver(
  entries: Readonly<Record<string, RouterCodexCheckout>> | undefined,
  zeroDir: string,
) {
  const checkouts = new Map(
    Object.entries(entries ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  )
  return async (
    repository: string,
    principal: 'web' | CommissionOperator,
  ): Promise<string | null> => {
    const key = repository.toLowerCase()
    const checkout = checkouts.get(key)
    if (!checkout || !isAbsolute(checkout.path)) return null
    if (
      principal !== 'web' &&
      !checkout.imChannels?.some(
        (channel) =>
          channel.platform === principal.platform && channel.channelId === principal.channelId,
      )
    )
      return null
    try {
      const [directory, runtime] = await Promise.all([realpath(checkout.path), realpath(zeroDir)])
      if (contains(directory, runtime) || contains(runtime, directory)) return null
      await access(directory, constants.W_OK | constants.X_OK)
      if (
        await lstat(join(directory, '.zero')).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
      )
        return null
      const top = await gitReadOnly(directory, ['rev-parse', '--show-toplevel'])
      if (top.trimEnd() !== directory) return null
      const origin = await gitReadOnly(directory, [
        'config',
        '--local',
        '--no-includes',
        '--null',
        '--get-all',
        'remote.origin.url',
      ])
      if (!origin.endsWith('\0')) return null
      const match =
        /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([a-z0-9-]+\/[a-z0-9_.-]+)\/?$/i.exec(
          origin.slice(0, -1),
        )
      const slug = match?.[1].toLowerCase()
      return slug === key || slug === `${key}.git` ? directory : null
    } catch {
      // Command errors can contain the raw origin (potentially including credentials).
      // Missing paths, inaccessible config and invalid checkouts all deny workspace access.
      return null
    }
  }
}
