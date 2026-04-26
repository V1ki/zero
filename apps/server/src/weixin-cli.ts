import { createRequire } from 'node:module'
import { runQrLogin } from '@zero-os/channel'
import { Vault, getMasterKey } from '@zero-os/secrets'

const require = createRequire(import.meta.url)
const qrcodeTerminal = require('qrcode-terminal') as {
  generate: (
    input: string,
    options: { small?: boolean },
    callback: (qr: string) => void,
  ) => void
}

/**
 * CLI handler for `bun zero weixin <sub>`.
 * Currently supports only `login`.
 */
export async function weixinCli(
  args: string[],
  context: { secretsPath: string },
): Promise<void> {
  const sub = args[0]
  if (sub !== 'login') {
    console.error('Usage: bun zero weixin login [--name <channel>]')
    process.exit(1)
    return
  }

  const name = parseNamedOption(args.slice(1), '--name') ?? 'weixin'

  console.log(`[ZeRo OS] Starting Weixin QR login for channel "${name}"...`)

  const result = await runQrLogin({
    onQrCode: (qr) => {
      console.log('')
      console.log('请用微信扫描以下二维码：')
      console.log(renderQrForTerminal(qr.imageContent || qr.value))
      if (qr.imageContent) console.log(qr.imageContent)
      console.log(`qrcode=${qr.value}`)
    },
    onStatus: (state) => {
      if (state === 'scaned') console.log('已扫码，请在微信里点击确认…')
      if (state === 'expired') console.log('二维码已过期，正在刷新…')
      if (state === 'scaned_but_redirect') console.log('切换接入点…')
    },
  })

  if (!result) {
    console.error('[ZeRo OS] Weixin QR login failed or timed out')
    process.exit(1)
    return
  }

  const { credentials } = result
  console.log(`[ZeRo OS] Login confirmed. accountId=${credentials.accountId}`)

  // Persist credentials into the Zero vault so main.ts picks them up next
  // start. This is the same flow as `bun zero secret set`.
  let masterKey: Buffer
  try {
    masterKey = await getMasterKey()
  } catch {
    console.error('[ZeRo OS] No master key available. Run `bun zero init` first.')
    process.exit(1)
    return
  }
  const vault = new Vault(masterKey, context.secretsPath)
  vault.set(`weixin_${name}_account_id`, credentials.accountId)
  vault.set(`weixin_${name}_token`, credentials.token)
  if (credentials.baseUrl) vault.set(`weixin_${name}_base_url`, credentials.baseUrl)
  vault.save()

  console.log(`[ZeRo OS] Stored in vault:`)
  console.log(`  weixin_${name}_account_id`)
  console.log(`  weixin_${name}_token`)
  if (credentials.baseUrl) console.log(`  weixin_${name}_base_url`)
  console.log('')
  console.log('Add the following to .zero/config.yaml under channels:')
  console.log('')
  console.log(`  - type: weixin`)
  console.log(`    name: ${name}`)
  console.log(`    accountIdRef: weixin_${name}_account_id`)
  console.log(`    tokenRef: weixin_${name}_token`)
  if (credentials.baseUrl) console.log(`    baseUrlRef: weixin_${name}_base_url`)
  console.log(`    dmPolicy: open`)
  console.log(`    groupPolicy: disabled`)
  console.log('')
  console.log('Then run `bun zero restart` to activate.')
}

function parseNamedOption(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) return args[i + 1]
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1)
  }
  return undefined
}

export function renderQrForTerminal(payload: string): string {
  let rendered = ''
  qrcodeTerminal.generate(payload, { small: true }, (qr: string) => {
    rendered = qr
  })
  return rendered.trimEnd()
}
