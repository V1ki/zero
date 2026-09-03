import { loadConfig } from '@zero-os/core'
import { MasterKeyMissingError, type Vault, loadVault } from '@zero-os/secrets'
import { type ManagedOAuthProviderKind, toErrorMessage } from '@zero-os/shared'
import type { ManagedOAuthStatus } from '../oauth/status'
import {
  createManagedOAuthCoordinator,
  getManagedOAuthProviderLabel,
  isManagedOAuthProviderKind,
  prepareManagedOAuthProvider,
  syncManagedOAuthCoordinator,
} from '../providers/managed-oauth'

export const PROVIDER_LOGIN_USAGE =
  'Usage: bun zero provider login <chatgpt|anthropic|x-premium> [--name <name>]'

interface ProviderLoginTargetFlags {
  name?: string
}

export interface ProviderLoginTargetRequest {
  kind: ManagedOAuthProviderKind
  flags: ProviderLoginTargetFlags
}

export interface ProviderLoginTarget {
  kind: ManagedOAuthProviderKind
  providerName: string
  label: string
}

export interface ProviderLoginOAuthClient {
  start(providerName: string): Promise<{ url: string }>
  waitForCompletion(providerName: string, timeoutMs?: number): Promise<ManagedOAuthStatus>
  completeFromInput(providerName: string, rawInput: string): Promise<ManagedOAuthStatus>
}

interface ProviderLoginCompletionDeps {
  openBrowser(url: string): void
  reloadServer(providerName: string): Promise<void>
  log(message: string): void
}

const defaultCompletionDeps: ProviderLoginCompletionDeps = {
  openBrowser: tryOpenBrowser,
  reloadServer: tryReloadRunningServer,
  log: (message) => console.log(message),
}

export async function runProviderCommand(options: {
  configPath: string
  secretsPath: string
  args: string[]
}): Promise<void> {
  const request = parseProviderLoginTargetRequest(options.args)
  if (!request) {
    console.error(PROVIDER_LOGIN_USAGE)
    process.exit(1)
  }

  let vault: Vault
  try {
    vault = await loadVault(options.secretsPath)
  } catch (error) {
    if (!(error instanceof MasterKeyMissingError)) throw error
    console.error('[ZeRo OS] No master key found. Run `bun zero init` first.')
    process.exit(1)
  }

  let providerName: string = request.kind
  let label = getManagedOAuthProviderLabel(request.kind)
  try {
    const target = prepareProviderLoginTarget(request)
    providerName = target.providerName
    label = target.label
  } catch (error) {
    console.error(
      `[ZeRo OS] Failed to prepare ${getManagedOAuthProviderLabel(request.kind)} provider config:`,
      toErrorMessage(error),
    )
    process.exit(1)
  }

  const config = loadConfig(options.configPath)
  const oauth = createManagedOAuthCoordinator(vault, config)
  syncManagedOAuthCoordinator(oauth, config)

  try {
    if (await completeProviderLoginViaBrowser({ oauth, providerName, label })) return
  } catch (error) {
    console.error(`[ZeRo OS] Failed to start ${label} OAuth login:`, toErrorMessage(error))
    process.exit(1)
  }

  const pasted = prompt('Paste the callback URL or authorization code:')
  if (!pasted) {
    console.error('[ZeRo OS] OAuth login cancelled.')
    process.exit(1)
  }

  try {
    await completeProviderLoginFromInput({
      oauth,
      providerName,
      label,
      input: pasted,
    })
  } catch (error) {
    console.error(`[ZeRo OS] ${label} OAuth login failed:`, toErrorMessage(error))
    process.exit(1)
  }
}

export function parseProviderLoginTargetRequest(args: string[]): ProviderLoginTargetRequest | null {
  const action = args[0]
  const target = args[1]
  if (action !== 'login' || !target || !isManagedOAuthProviderKind(target)) {
    return null
  }

  return {
    kind: target,
    flags: parseProviderLoginTargetFlags(args.slice(2)),
  }
}

export function prepareProviderLoginTarget(
  request: ProviderLoginTargetRequest,
): ProviderLoginTarget {
  const prepared = prepareManagedOAuthProvider(request.kind, {
    name: request.flags.name,
  })
  return {
    kind: request.kind,
    providerName: prepared.providerName,
    label: buildProviderLoginLabel(request.kind, prepared.providerName),
  }
}

export function buildProviderLoginLabel(
  kind: ManagedOAuthProviderKind,
  providerName: string,
): string {
  const baseLabel = getManagedOAuthProviderLabel(kind)
  return providerName === kind ? baseLabel : `${baseLabel} (${providerName})`
}

export async function completeProviderLoginViaBrowser(options: {
  oauth: ProviderLoginOAuthClient
  providerName: string
  label: string
  timeoutMs?: number
  deps?: Partial<ProviderLoginCompletionDeps>
}): Promise<boolean> {
  const deps = { ...defaultCompletionDeps, ...options.deps }
  const { url } = await options.oauth.start(options.providerName)
  deps.log(`[ZeRo OS] Starting ${options.label} OAuth login...`)
  deps.log(`  URL: ${url}`)

  deps.openBrowser(url)

  try {
    const status = await options.oauth.waitForCompletion(
      options.providerName,
      options.timeoutMs ?? 120_000,
    )
    if (status.state !== 'connected') return false

    await deps.reloadServer(options.providerName)
    deps.log(`[ZeRo OS] ${options.label} OAuth configured.`)
    return true
  } catch (error) {
    const message = toErrorMessage(error)
    if (!message.toLowerCase().includes('timed out')) {
      deps.log(`[ZeRo OS] Browser callback not completed automatically: ${message}`)
    }
    return false
  }
}

export async function completeProviderLoginFromInput(options: {
  oauth: ProviderLoginOAuthClient
  providerName: string
  label: string
  input: string
  deps?: Partial<ProviderLoginCompletionDeps>
}): Promise<void> {
  const deps = { ...defaultCompletionDeps, ...options.deps }
  const status = await options.oauth.completeFromInput(options.providerName, options.input)
  if (status.state !== 'connected') {
    throw new Error(status.error ?? 'Authentication failed')
  }

  await deps.reloadServer(options.providerName)
  deps.log(`[ZeRo OS] ${options.label} OAuth configured.`)
}

async function tryReloadRunningServer(recoveredProvider?: string): Promise<void> {
  const port = Number(process.env.PORT ?? 3001)
  try {
    const response = await fetch(`http://localhost:${port}/api/runtime/model-providers/reload`, {
      method: 'POST',
      headers: recoveredProvider ? { 'Content-Type': 'application/json' } : undefined,
      body: recoveredProvider ? JSON.stringify({ recoveredProvider }) : undefined,
    })
    if (response.ok) {
      console.log('[ZeRo OS] Running server reloaded provider config.')
      return
    }
    console.log('[ZeRo OS] Provider saved. Restart ZeRo if the running server does not pick it up.')
  } catch {
    console.log('[ZeRo OS] Provider saved. Start or restart ZeRo to use it.')
  }
}

function tryOpenBrowser(url: string): void {
  const openCommand =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]

  try {
    Bun.spawn(openCommand, { stdout: 'ignore', stderr: 'ignore' })
  } catch {}
}

function parseProviderLoginTargetFlags(args: string[]): ProviderLoginTargetFlags {
  let name: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--name' || arg === '-n') {
      name = args[index + 1]
      index++
    } else if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length)
    }
  }
  return { name }
}
