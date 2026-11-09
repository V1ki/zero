import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { CommissionOperator, RouterCodexCheckout } from '@zero-os/shared'

import { TriggerAgentError } from './event-agent'

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
  principalFor: (actor: 'web' | CommissionOperator) => string | null,
  managed?: {
    isTracked(repository: string): boolean
    root?: string
    clone?(repository: string, destination: string): Promise<void>
  },
) {
  const checkouts = new Map(
    Object.entries(entries ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  )
  return async (
    repository: string,
    principal: 'web' | CommissionOperator,
  ): Promise<string | null> => {
    const key = repository.toLowerCase()
    if (principalFor(principal) !== 'router-owner') return null
    const mapped = checkouts.get(key)
    let path = mapped?.path
    if (!path && managed?.isTracked(key)) {
      if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/u.test(key) || /\/\.{1,2}$/u.test(key)) return null
      // Keep managed repositories outside both the ZeRo installation and its private runtime data.
      path = join(
        managed.root ?? join(homedir(), '.local', 'share', 'zero', 'router-checkouts'),
        key,
      )
      const exists = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!exists) {
        await mkdir(dirname(path), { recursive: true })
        const temp = await mkdtemp(path + '-')
        try {
          if (managed.clone) await managed.clone(key, temp)
          else
            await run('gh', ['repo', 'clone', `https://github.com/${key}`, temp], {
              env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
            })
          if (!managed.isTracked(key) || principalFor(principal) !== 'router-owner') return null
          try {
            await rename(temp, path)
          } catch (error) {
            // Another request may have completed the same clone. Validate its origin below.
            if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
              throw error
          }
        } catch {
          throw new TriggerAgentError(
            `未能取得 ${key} 的工作副本。请核对本机 gh 对该仓库的读取能力及工作目录的可写性。`,
          )
        } finally {
          await rm(temp, { force: true, recursive: true })
        }
      }
    }
    if (!path || !isAbsolute(path)) return null
    try {
      const [directory, runtime] = await Promise.all([realpath(path), realpath(zeroDir)])
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
