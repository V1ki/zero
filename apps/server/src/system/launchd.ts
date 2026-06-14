import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getBunExecutable, getRuntimeEnv } from './runtime'

export const SUPERVISOR_LABEL = 'com.zero-os.supervisor'

const LAUNCHCTL_BIN = '/bin/launchctl'

export interface SupervisorLaunchAgentPaths {
  projectRoot: string
  userHome: string
  zeroDir: string
  logsDir: string
  supervisorEntry: string
  plistPath: string
  stdoutPath: string
  stderrPath: string
  bunPath: string
}

export interface SupervisorLaunchAgentStatus extends SupervisorLaunchAgentPaths {
  installed: boolean
  loaded: boolean
  details?: string
}

interface LaunchctlResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

export function getSupervisorLaunchAgentPaths(
  projectRoot = process.cwd(),
  userHome = homedir(),
  bunPath = getBunExecutable(),
): SupervisorLaunchAgentPaths {
  const zeroDir = join(projectRoot, '.zero')
  const logsDir = join(zeroDir, 'logs')

  return {
    projectRoot,
    userHome,
    zeroDir,
    logsDir,
    supervisorEntry: join(projectRoot, 'apps/supervisor/src/main.ts'),
    plistPath: join(userHome, 'Library/LaunchAgents', `${SUPERVISOR_LABEL}.plist`),
    stdoutPath: join(logsDir, 'supervisor.log'),
    stderrPath: join(logsDir, 'supervisor.error.log'),
    bunPath,
  }
}

export function renderSupervisorLaunchAgentPlist(paths: SupervisorLaunchAgentPaths) {
  const env = {
    HOME: paths.userHome,
    PATH: getRuntimeEnv().PATH ?? dirname(paths.bunPath),
    ...(process.env.USER ? { USER: process.env.USER } : {}),
    ...(process.env.SHELL ? { SHELL: process.env.SHELL } : {}),
    ...(process.env.BUN_INSTALL ? { BUN_INSTALL: process.env.BUN_INSTALL } : {}),
  }

  const envLines = Object.entries(env)
    .map(
      ([key, value]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(SUPERVISOR_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(paths.bunPath)}</string>
    <string>run</string>
    <string>${escapeXml(paths.supervisorEntry)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(paths.projectRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${envLines}
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(paths.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(paths.stderrPath)}</string>
</dict>
</plist>
`
}

export function installSupervisorLaunchAgent(projectRoot = process.cwd()) {
  ensureDarwin()

  const paths = getSupervisorLaunchAgentPaths(projectRoot)
  const domain = getLaunchctlDomain()

  mkdirSync(dirname(paths.plistPath), { recursive: true })
  mkdirSync(paths.logsDir, { recursive: true })
  writeFileSync(paths.plistPath, renderSupervisorLaunchAgentPlist(paths), 'utf8')

  runLaunchctl(['bootout', domain, paths.plistPath])

  const bootstrap = runLaunchctl(['bootstrap', domain, paths.plistPath])
  if (!bootstrap.ok) {
    throw new Error(formatLaunchctlError('bootstrap launch agent', bootstrap))
  }

  const kickstart = runLaunchctl(['kickstart', '-k', `${domain}/${SUPERVISOR_LABEL}`])
  if (!kickstart.ok) {
    throw new Error(formatLaunchctlError('start supervisor service', kickstart))
  }

  return paths
}

export function uninstallSupervisorLaunchAgent(projectRoot = process.cwd()) {
  ensureDarwin()

  const paths = getSupervisorLaunchAgentPaths(projectRoot)
  const domain = getLaunchctlDomain()

  if (existsSync(paths.plistPath)) {
    runLaunchctl(['bootout', domain, paths.plistPath])
    rmSync(paths.plistPath, { force: true })
  }

  return paths
}

export function getSupervisorLaunchAgentStatus(
  projectRoot = process.cwd(),
): SupervisorLaunchAgentStatus {
  const paths = getSupervisorLaunchAgentPaths(projectRoot)

  if (process.platform !== 'darwin') {
    return {
      ...paths,
      installed: existsSync(paths.plistPath),
      loaded: false,
      details: 'launchctl is only available on macOS',
    }
  }

  const domain = getLaunchctlDomain()
  const installed = existsSync(paths.plistPath)
  const status = runLaunchctl(['print', `${domain}/${SUPERVISOR_LABEL}`])

  return {
    ...paths,
    installed,
    loaded: status.ok,
    details: status.ok ? status.stdout : status.stderr || status.stdout,
  }
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function ensureDarwin() {
  if (process.platform !== 'darwin') {
    throw new Error('launchctl integration is only supported on macOS')
  }
}

function getLaunchctlDomain() {
  if (typeof process.getuid !== 'function') {
    throw new Error('Unable to determine the current macOS user id')
  }

  return `gui/${process.getuid()}`
}

function runLaunchctl(args: string[]): LaunchctlResult {
  const result = spawnSync(LAUNCHCTL_BIN, args, {
    env: getRuntimeEnv(),
    encoding: 'utf8',
  })

  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  }
}

function formatLaunchctlError(action: string, result: LaunchctlResult) {
  const detail = result.stderr || result.stdout || `exit code ${result.code ?? 'unknown'}`
  return `Failed to ${action}: ${detail}`
}
