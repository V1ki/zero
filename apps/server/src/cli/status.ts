import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getMasterKey, loadVault } from '@zero-os/secrets'
import { getManagedOAuthTokenRefForKind } from '../providers/managed-oauth'
import { getSupervisorLaunchAgentStatus } from '../system/launchd'

export async function runStatusCommand(options: {
  zeroDir: string
  secretsPath: string
}): Promise<void> {
  console.log('[ZeRo OS] Status\n')

  const configExists = existsSync(join(options.zeroDir, 'config.yaml'))
  console.log(`  Config:    ${configExists ? '✓ found' : '✗ missing'}`)

  const secretsExist = existsSync(options.secretsPath)
  console.log(`  Secrets:   ${secretsExist ? '✓ found' : '✗ missing'}`)

  try {
    await getMasterKey()
    console.log('  Keychain:  ✓ master key found')
  } catch {
    console.log('  Keychain:  ✗ no master key')
  }

  if (secretsExist) {
    try {
      const vault = await loadVault(options.secretsPath)
      const hasApiKey = vault.get('openai_codex_api_key')
      const hasChatGptOauth = vault.get(getManagedOAuthTokenRefForKind('chatgpt'))
      const hasClaudeOauth = vault.get(getManagedOAuthTokenRefForKind('anthropic'))
      const hasXPremiumOauth = vault.get(getManagedOAuthTokenRefForKind('x-premium'))
      console.log(`  API Key:   ${hasApiKey ? '✓ configured' : '✗ not set'}`)
      console.log(`  ChatGPT:   ${hasChatGptOauth ? '✓ OAuth configured' : '✗ not set'}`)
      console.log(`  Claude:    ${hasClaudeOauth ? '✓ OAuth configured' : '✗ not set'}`)
      console.log(`  X Premium: ${hasXPremiumOauth ? '✓ OAuth configured' : '✗ not set'}`)
      console.log(`  Keys:      ${vault.keys().length} total`)
    } catch {
      console.log('  API Key:   ? cannot read vault')
    }
  }

  const logsExist = existsSync(join(options.zeroDir, 'logs'))
  console.log(`  Logs:      ${logsExist ? '✓ found' : '✗ missing'}`)

  const webBuild = existsSync(join(process.cwd(), 'apps/web/dist'))
  console.log(`  Web Build: ${webBuild ? '✓ built' : '○ not built (run bun run build:web)'}`)

  if (process.platform !== 'darwin') return

  const launchAgent = getSupervisorLaunchAgentStatus()
  console.log(
    `  LaunchCtl: ${launchAgent.loaded ? '✓ loaded' : launchAgent.installed ? '○ installed, not loaded' : '✗ not installed'}`,
  )
  console.log(`  Agent:     ${launchAgent.plistPath}`)
}
