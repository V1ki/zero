import { Vault, getMasterKey } from '@zero-os/secrets'

export async function runSecretCommand(options: {
  secretsPath: string
  args: string[]
}): Promise<void> {
  const action = options.args[0]
  const key = options.args[1]
  const value = options.args[2]

  let masterKey: Buffer
  try {
    masterKey = await getMasterKey()
  } catch {
    console.error('[ZeRo OS] No master key found. Run `bun zero init` first.')
    process.exit(1)
  }

  const vault = new Vault(masterKey, options.secretsPath)
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
