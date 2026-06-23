import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_TEMPLATES } from '@zero-os/core'
import { Vault, generateMasterKey, getMasterKey, setMasterKey } from '@zero-os/secrets'
import { toErrorMessage } from '@zero-os/shared'
import { installSupervisorLaunchAgent } from '../system/launchd'

export async function runInitCommand(options: {
  zeroDir: string
  secretsPath: string
  apiKey?: string
}): Promise<void> {
  console.log('[ZeRo OS] Initializing...\n')

  let masterKey: Buffer
  const hasExistingVault = existsSync(options.secretsPath)
  try {
    masterKey = await getMasterKey()
    console.log('  Master key: already exists in Keychain')
  } catch {
    if (hasExistingVault) {
      console.error('  Master key: missing in Keychain')
      console.error(
        '  Existing secrets vault cannot be opened without the original master key. Restore the Keychain item or recover the vault before re-running init.',
      )
      process.exit(1)
    }
    masterKey = generateMasterKey()
    await setMasterKey(masterKey)
    console.log('  Master key: generated and stored in Keychain')
  }

  const vault = new Vault(masterKey, options.secretsPath)
  if (!hasExistingVault) {
    vault.save()
    console.log('  Secrets vault: created (.zero/secrets.enc)')
  } else {
    vault.load()
    console.log(`  Secrets vault: loaded (${vault.keys().length} keys)`)
  }

  const apiKeyRef = 'openai_codex_api_key'
  if (!vault.get(apiKeyRef)) {
    if (options.apiKey) {
      vault.set(apiKeyRef, options.apiKey)
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

  const agentWorkspace = join(options.zeroDir, 'workspace', 'zero')
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

  if (process.platform !== 'darwin') return

  try {
    const launchAgent = installSupervisorLaunchAgent()
    console.log(`  LaunchAgent: installed at ${launchAgent.plistPath}`)
  } catch (err) {
    console.log(`  LaunchAgent: not installed automatically (${toErrorMessage(err)})`)
    console.log('               Run `bun zero launchctl install` after fixing the issue.')
  }
}
