import { join } from 'node:path'
import { weixinCli } from '../channels/weixin'
import { printHelp } from './help'
import { runInitCommand } from './init'
import { runLaunchctlCommand } from './launchctl'
import { runLogsCommand } from './logs'
import { runProviderCommand } from './provider-login'
import { runRestartCommand } from './restart'
import { runSecretCommand } from './secrets'
import { runStartCommand } from './start'
import { runStatusCommand } from './status'

interface CliPaths {
  zeroDir: string
  secretsPath: string
  configPath: string
}

const RESTART_GRACE_PERIOD_SECONDS = 15

export async function runCli(argv = process.argv): Promise<void> {
  const paths = resolveCliPaths()
  const command = argv[2]
  const args = argv.slice(3)

  switch (command) {
    case 'init':
      await runInitCommand({
        zeroDir: paths.zeroDir,
        secretsPath: paths.secretsPath,
        apiKey: argv[3],
      })
      return
    case 'start':
      await runStartCommand({
        zeroDir: paths.zeroDir,
      })
      return
    case 'secret':
      await runSecretCommand({
        secretsPath: paths.secretsPath,
        args,
      })
      return
    case 'launchctl':
    case 'launchd':
      await runLaunchctlCommand(args)
      return
    case 'logs':
      await runLogsCommand({
        zeroDir: paths.zeroDir,
        args,
      })
      return
    case 'weixin':
      await weixinCli(args, {
        configPath: paths.configPath,
        secretsPath: paths.secretsPath,
      })
      return
    case 'status':
      await runStatusCommand({
        zeroDir: paths.zeroDir,
        secretsPath: paths.secretsPath,
      })
      return
    case 'restart':
      await runRestartCommand({
        zeroDir: paths.zeroDir,
        gracePeriodSeconds: RESTART_GRACE_PERIOD_SECONDS,
      })
      return
    case 'provider':
      await runProviderCommand({
        configPath: paths.configPath,
        secretsPath: paths.secretsPath,
        args,
      })
      return
    default:
      printHelp()
  }
}

function resolveCliPaths(cwd = process.cwd()): CliPaths {
  const zeroDir = join(cwd, '.zero')
  return {
    zeroDir,
    secretsPath: join(zeroDir, 'secrets.enc'),
    configPath: join(zeroDir, 'config.yaml'),
  }
}
