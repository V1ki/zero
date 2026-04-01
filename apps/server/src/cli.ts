import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_TEMPLATES } from '@zero-os/core'
import { Vault, generateMasterKey, getMasterKey, setMasterKey } from '@zero-os/secrets'
import { installConsoleTimestamping, toErrorMessage } from '@zero-os/shared'
import { getChatgptOAuthTokenRef } from './chatgpt-provider'
import { getClaudeOAuthSessionRef } from './claude-provider'
import {
  getSupervisorLaunchAgentStatus,
  installSupervisorLaunchAgent,
  uninstallSupervisorLaunchAgent,
} from './launchd'
import { startZeroOS } from './main'
import {
  createManagedOAuthCoordinator,
  getManagedOAuthProviderLabel,
  isManagedOAuthProvider,
  prepareManagedOAuthProvider,
} from './provider-oauth'
import { writeRestartTrigger } from './restart-trigger'
import { rebuildWebBundle } from './web-build'

const ZERO_DIR = join(process.cwd(), '.zero')
const SECRETS_PATH = join(ZERO_DIR, 'secrets.enc')
const RESTART_GRACE_PERIOD_S = 15

const command = process.argv[2]

switch (command) {
  case 'init':
    await init()
    break
  case 'start':
    await start()
    break
  case 'secret':
    await secret()
    break
  case 'launchctl':
  case 'launchd':
    await launchctl()
    break
  case 'logs':
    await logs()
    break
  case 'status':
    await status()
    break
  case 'restart':
    await restart()
    break
  case 'provider':
    await provider()
    break
  default:
    printHelp()
    break
}

async function init() {
  console.log('[ZeRo OS] Initializing...\n')

  // 1. Generate master key
  let masterKey: Buffer
  try {
    masterKey = await getMasterKey()
    console.log('  Master key: already exists in Keychain')
  } catch {
    masterKey = generateMasterKey()
    await setMasterKey(masterKey)
    console.log('  Master key: generated and stored in Keychain')
  }

  // 2. Create empty vault if not exists
  const vault = new Vault(masterKey, SECRETS_PATH)
  if (!existsSync(SECRETS_PATH)) {
    vault.save()
    console.log('  Secrets vault: created (.zero/secrets.enc)')
  } else {
    vault.load()
    console.log(`  Secrets vault: loaded (${vault.keys().length} keys)`)
  }

  // 3. Prompt for API key if not set
  const apiKeyRef = 'openai_codex_api_key'
  if (!vault.get(apiKeyRef)) {
    const apiKey = process.argv[3]
    if (apiKey) {
      vault.set(apiKeyRef, apiKey)
      console.log(`  API key: stored as "${apiKeyRef}"`)
    } else {
      console.log('\n  ⚠  No API key found. Run:')
      console.log('     bun zero init <your-api-key>')
      console.log('     or:')
      console.log('     bun zero secret set openai_codex_api_key <your-api-key>')
    }
  } else {
    console.log(`  API key: "${apiKeyRef}" already configured`)
  }

  // 4. Create default bootstrap files for "zero" agent
  const agentWorkspace = join(ZERO_DIR, 'workspace', 'zero')
  mkdirSync(agentWorkspace, { recursive: true })

  for (const [name, template] of Object.entries(DEFAULT_TEMPLATES)) {
    const filePath = join(agentWorkspace, name)
    if (!existsSync(filePath)) {
      writeFileSync(filePath, template)
      console.log(`  Bootstrap: created ${name}`)
    } else {
      console.log(`  Bootstrap: ${name} already exists`)
    }
  }

  console.log('\n[ZeRo OS] Init complete. Run `bun zero start` to launch.')

  if (process.platform === 'darwin') {
    try {
      const launchAgent = installSupervisorLaunchAgent()
      console.log(`  LaunchAgent: installed at ${launchAgent.plistPath}`)
    } catch (err) {
      console.log(`  LaunchAgent: not installed automatically (${toErrorMessage(err)})`)
      console.log('               Run `bun zero launchctl install` after fixing the issue.')
    }
  }
}

async function start() {
  installConsoleTimestamping()

  // Pre-flight check
  if (!existsSync(join(ZERO_DIR, 'config.yaml'))) {
    console.error('[ZeRo OS] Error: .zero/config.yaml not found. Run `bun zero init` first.')
    process.exit(1)
  }

  const zero = await startZeroOS({
    onCoreReady: async (runtime) => {
      const { startWebServer } = await import('../../web/src/server')
      const web = startWebServer(runtime)
      console.log(`[ZeRo OS] Web UI: http://localhost:${web.port}`)
    },
  })

  process.on('SIGINT', () => zero.shutdown())
  process.on('SIGTERM', () => zero.shutdown())
}

async function secret() {
  const action = process.argv[3]
  const key = process.argv[4]
  const value = process.argv[5]

  let masterKey: Buffer
  try {
    masterKey = await getMasterKey()
  } catch {
    console.error('[ZeRo OS] No master key found. Run `bun zero init` first.')
    process.exit(1)
  }

  const vault = new Vault(masterKey, SECRETS_PATH)
  vault.load()

  switch (action) {
    case 'set': {
      if (!key || !value) {
        console.error('Usage: bun zero secret set <key> <value>')
        process.exit(1)
      }
      vault.set(key, value)
      console.log(`Secret "${key}" stored.`)
      break
    }

    case 'list': {
      const keys = vault.keys()
      if (keys.length === 0) {
        console.log('No secrets stored.')
      } else {
        console.log('Stored secrets:')
        for (const k of keys) {
          console.log(`  - ${k}`)
        }
      }
      break
    }

    case 'delete': {
      if (!key) {
        console.error('Usage: bun zero secret delete <key>')
        process.exit(1)
      }
      vault.delete(key)
      console.log(`Secret "${key}" deleted.`)
      break
    }

    default:
      console.log('Usage:')
      console.log('  bun zero secret set <key> <value>')
      console.log('  bun zero secret list')
      console.log('  bun zero secret delete <key>')
      break
  }
}

async function provider() {
  const action = process.argv[3]
  const target = process.argv[4]

  if (action !== 'login' || !target || !isManagedOAuthProvider(target)) {
    console.error('Usage: bun zero provider login <chatgpt|claude>')
    process.exit(1)
  }

  let masterKey: Buffer
  try {
    masterKey = await getMasterKey()
  } catch {
    console.error('[ZeRo OS] No master key found. Run `bun zero init` first.')
    process.exit(1)
  }

  const vault = new Vault(masterKey, SECRETS_PATH)
  vault.load()

  try {
    prepareManagedOAuthProvider(target)
  } catch (error) {
    console.error(
      `[ZeRo OS] Failed to prepare ${getManagedOAuthProviderLabel(target)} provider config:`,
      toErrorMessage(error),
    )
    process.exit(1)
  }

  const oauth = createManagedOAuthCoordinator(vault)
  const label = getManagedOAuthProviderLabel(target)

  try {
    const { url } = await oauth.start(target)
    console.log(`[ZeRo OS] Starting ${label} OAuth login...`)
    console.log(`  URL: ${url}`)

    tryOpenBrowser(url)

    const status = await oauth.waitForCompletion(target, 120_000)
    if (status.state === 'connected') {
      console.log(
        `[ZeRo OS] ${label} OAuth configured. Run \`bun zero restart\` to use the new provider.`,
      )
      return
    }
  } catch (error) {
    const message = toErrorMessage(error)
    if (!message.toLowerCase().includes('timed out')) {
      console.log(`[ZeRo OS] Browser callback not completed automatically: ${message}`)
    }
  }

  const pasted = prompt('Paste the callback URL or authorization code:')
  if (!pasted) {
    console.error('[ZeRo OS] OAuth login cancelled.')
    process.exit(1)
  }

  try {
    const status = await oauth.completeFromInput(target, pasted)
    if (status.state !== 'connected') {
      throw new Error(status.error ?? 'Authentication failed')
    }
    console.log(
      `[ZeRo OS] ${label} OAuth configured. Run \`bun zero restart\` to use the new provider.`,
    )
  } catch (error) {
    console.error(`[ZeRo OS] ${label} OAuth login failed:`, toErrorMessage(error))
    process.exit(1)
  }
}

function tryOpenBrowser(url: string) {
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

async function status() {
  console.log('[ZeRo OS] Status\n')

  // Config
  const configExists = existsSync(join(ZERO_DIR, 'config.yaml'))
  console.log(`  Config:    ${configExists ? '✓ found' : '✗ missing'}`)

  // Secrets
  const secretsExist = existsSync(SECRETS_PATH)
  console.log(`  Secrets:   ${secretsExist ? '✓ found' : '✗ missing'}`)

  // Master key
  try {
    await getMasterKey()
    console.log('  Keychain:  ✓ master key found')
  } catch {
    console.log('  Keychain:  ✗ no master key')
  }

  // API Key
  if (secretsExist) {
    try {
      const masterKey = await getMasterKey()
      const vault = new Vault(masterKey, SECRETS_PATH)
      vault.load()
      const hasApiKey = vault.get('openai_codex_api_key')
      const hasChatGptOauth = vault.get(getChatgptOAuthTokenRef())
      const hasClaudeOauth = vault.get(getClaudeOAuthSessionRef())
      console.log(`  API Key:   ${hasApiKey ? '✓ configured' : '✗ not set'}`)
      console.log(`  ChatGPT:   ${hasChatGptOauth ? '✓ OAuth configured' : '✗ not set'}`)
      console.log(`  Claude:    ${hasClaudeOauth ? '✓ OAuth configured' : '✗ not set'}`)
      console.log(`  Keys:      ${vault.keys().length} total`)
    } catch {
      console.log('  API Key:   ? cannot read vault')
    }
  }

  // Logs dir
  const logsExist = existsSync(join(ZERO_DIR, 'logs'))
  console.log(`  Logs:      ${logsExist ? '✓ found' : '✗ missing'}`)

  // Web build
  const webBuild = existsSync(join(process.cwd(), 'apps/web/dist'))
  console.log(`  Web Build: ${webBuild ? '✓ built' : '○ not built (run bun run build:web)'}`)

  if (process.platform === 'darwin') {
    const launchAgent = getSupervisorLaunchAgentStatus()
    console.log(
      `  LaunchCtl: ${launchAgent.loaded ? '✓ loaded' : launchAgent.installed ? '○ installed, not loaded' : '✗ not installed'}`,
    )
    console.log(`  Agent:     ${launchAgent.plistPath}`)
  }
}

async function launchctl() {
  if (process.platform !== 'darwin') {
    console.error('[ZeRo OS] launchctl integration is only available on macOS.')
    process.exit(1)
  }

  const action = process.argv[3] ?? 'install'

  try {
    switch (action) {
      case 'install': {
        const launchAgent = installSupervisorLaunchAgent()
        console.log('[ZeRo OS] Supervisor LaunchAgent installed.')
        console.log(`  Label: ${'com.zero-os.supervisor'}`)
        console.log(`  Plist: ${launchAgent.plistPath}`)
        break
      }

      case 'uninstall': {
        const launchAgent = uninstallSupervisorLaunchAgent()
        console.log('[ZeRo OS] Supervisor LaunchAgent removed.')
        console.log(`  Plist: ${launchAgent.plistPath}`)
        break
      }

      case 'status': {
        const launchAgent = getSupervisorLaunchAgentStatus()
        console.log('[ZeRo OS] Supervisor LaunchAgent status')
        console.log(`  Label:      ${'com.zero-os.supervisor'}`)
        console.log(`  Installed:  ${launchAgent.installed ? 'yes' : 'no'}`)
        console.log(`  Loaded:     ${launchAgent.loaded ? 'yes' : 'no'}`)
        console.log(`  Plist:      ${launchAgent.plistPath}`)
        if (launchAgent.details) {
          console.log(`  Details:    ${launchAgent.details.split('\n')[0]}`)
        }
        break
      }

      default:
        console.error('Usage: bun zero launchctl <install|uninstall|status>')
        process.exit(1)
    }
  } catch (err) {
    console.error('[ZeRo OS] launchctl command failed:', toErrorMessage(err))
    process.exit(1)
  }
}

async function logs() {
  const args = process.argv.slice(3)
  const follow = args.includes('--follow') || args.includes('-f')
  const lines = getLogsLineCount(args)

  const target = args.find((arg) => !arg.startsWith('-') && !/^\d+$/.test(arg)) ?? 'all'
  const logFiles = getLogFiles(target)

  const existingFiles = logFiles.filter((file) => existsSync(file))

  if (existingFiles.length === 0) {
    console.log('[ZeRo OS] No supervisor log files found yet.')
    for (const file of logFiles) {
      console.log(`  - ${file}`)
    }
    return
  }

  const tailArgs = ['-n', String(lines), ...existingFiles]

  if (follow) {
    console.log(`[ZeRo OS] Following ${existingFiles.length} log file(s)...`)
    const proc = Bun.spawn(['tail', '-f', ...tailArgs], {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    })
    await proc.exited
    return
  }

  const result = spawnSync('tail', tailArgs, {
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    console.error('[ZeRo OS] Failed to read logs.')
    process.exit(result.status ?? 1)
  }
}

function getLogsLineCount(args: string[]) {
  const lineFlagIndex = args.findIndex((arg) => arg === '--lines' || arg === '-n')

  if (lineFlagIndex === -1) {
    return 100
  }

  const rawValue = args[lineFlagIndex + 1]
  const parsedValue = Number(rawValue)

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue <= 0) {
    console.error('Usage: bun zero logs [supervisor|error|all] [--lines <n>] [--follow]')
    process.exit(1)
  }

  return parsedValue
}

function getLogFiles(target: string) {
  const stdoutPath = join(ZERO_DIR, 'logs', 'supervisor.log')
  const stderrPath = join(ZERO_DIR, 'logs', 'supervisor.error.log')

  switch (target) {
    case 'supervisor':
    case 'out':
      return [stdoutPath]
    case 'error':
    case 'err':
      return [stderrPath]
    case 'all':
      return [stdoutPath, stderrPath]
    default:
      console.error('Usage: bun zero logs [supervisor|error|all] [--lines <n>] [--follow]')
      process.exit(1)
  }
}

async function restart() {
  const heartbeatPath = join(ZERO_DIR, 'heartbeat.json')
  if (!existsSync(heartbeatPath)) {
    console.error('[ZeRo OS] No heartbeat file found. Is the server running?')
    process.exit(1)
  }

  try {
    const data = JSON.parse(readFileSync(heartbeatPath, 'utf-8')) as {
      pid: number
      uptime?: number
    }

    if (typeof data.uptime === 'number' && data.uptime < RESTART_GRACE_PERIOD_S) {
      console.error(
        `[ZeRo OS] Refusing restart: process just started and is still in the startup grace period (${data.uptime.toFixed(1)}s < ${RESTART_GRACE_PERIOD_S}s).`,
      )
      process.exit(1)
    }

    console.log('[ZeRo OS] Rebuilding web UI before restart...')
    const build = rebuildWebBundle()
    if (!build.ok) {
      console.error('[ZeRo OS] Web rebuild failed:', build.error)
      process.exit(1)
    }

    const pid = data.pid as number
    writeRestartTrigger(ZERO_DIR, {
      source: 'cli',
      sessionId: process.env.ZERO_SESSION_ID,
      channelName: process.env.ZERO_CHANNEL_NAME,
      channelId: process.env.ZERO_CHANNEL_ID,
    })
    process.kill(pid, 'SIGTERM')
    console.log(`[ZeRo OS] Sent SIGTERM to PID ${pid}. Supervisor will restart the process.`)
  } catch (err) {
    console.error('[ZeRo OS] Failed to restart:', toErrorMessage(err))
    process.exit(1)
  }
}

function printHelp() {
  console.log(`
ZeRo OS CLI

Usage:
  bun zero <command>

Commands:
  init [api-key]     Initialize ZeRo OS (Keychain, vault, directories)
  start              Start ZeRo OS (server + web UI)
  restart            Graceful restart (requires Supervisor running)
  launchctl install  Install/update macOS LaunchAgent for Supervisor
  launchctl status   Show macOS LaunchAgent status
  launchctl uninstall Remove macOS LaunchAgent for Supervisor
  logs [target]      View supervisor logs (supervisor | error | all)
  secret set <k> <v> Store a secret in the vault
  secret list        List all stored secret keys
  secret delete <k>  Delete a secret
  provider login <provider> Authenticate managed OAuth (chatgpt | claude)
  status             Show system status

Examples:
  bun zero init sk-your-api-key-here
  bun zero start
  bun zero restart
  bun zero launchctl install
  bun zero logs all --follow
  bun zero secret set openai_codex_api_key sk-xxx
  bun zero provider login chatgpt
  bun zero provider login claude
  bun zero status
`)
}
