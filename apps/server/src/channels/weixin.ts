import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runQrLogin, type WeixinChannel } from '@zero-os/channel'
import { Vault, getMasterKey } from '@zero-os/secrets'
import { readYaml, writeYaml } from '@zero-os/shared'
import type { ChannelAdapter, StreamAdapter, TypingHandle } from './adapter'

const require = createRequire(import.meta.url)
const qrcodeTerminal = require('qrcode-terminal') as {
  generate: (input: string, options: { small?: boolean }, callback: (qr: string) => void) => void
}

/**
 * Weixin channel adapter — bridges the Channel's chat protocol to the
 * internal ChannelAdapter surface. Weixin does not support message editing,
 * so `createStreaming` returns null and upper layers fall back to plain
 * `reply()`.
 */
export class WeixinAdapter implements ChannelAdapter {
  constructor(
    private readonly channel: WeixinChannel,
    private readonly typingKeepaliveMs = 5_000,
  ) {}

  async reply(chatId: string, text: string): Promise<void> {
    await this.channel.sendToChat(chatId, text)
  }

  async showTyping(chatId: string): Promise<TypingHandle | null> {
    await this.channel.sendTypingIndicator(chatId).catch(() => {})
    const timer = setInterval(() => {
      this.channel.sendTypingIndicator(chatId).catch(() => {})
    }, this.typingKeepaliveMs)
    let cleared = false
    return {
      clear: async () => {
        if (cleared) return
        cleared = true
        clearInterval(timer)
        await this.channel.clearTypingIndicator(chatId).catch(() => {})
      },
    }
  }

  async createStreaming(): Promise<StreamAdapter | null> {
    return null
  }

  async sendImage(chatId: string, imageBuffer: Buffer): Promise<void> {
    await this.channel.sendAttachment(chatId, imageBuffer, 'image.png', 'image/png')
  }

  async markDone(): Promise<void> {
    // Weixin does not support reactions
  }

  async markError(): Promise<void> {
    // Weixin does not support reactions
  }
}

export interface WeixinCliContext {
  configPath: string
  secretsPath: string
}

export interface WeixinConfigEntry {
  name: string
  accountIdRef: string
  tokenRef: string
  baseUrlRef?: string
}

/**
 * CLI handler for `bun zero weixin <sub>`.
 * Currently supports only `login`.
 */
export async function weixinCli(args: string[], context: WeixinCliContext): Promise<void> {
  const sub = args[0]
  if (sub !== 'login') {
    console.error('Usage: bun zero weixin login [--name <channel>]')
    process.exit(1)
    return
  }

  const name = parseNamedOption(args.slice(1), '--name') ?? 'weixin'
  const loggedIn = await loginWeixinChannel(name, context)
  if (loggedIn) return

  process.exit(1)
}

export function renderQrForTerminal(payload: string): string {
  let rendered = ''
  qrcodeTerminal.generate(payload, { small: true }, (qr: string) => {
    rendered = qr
  })
  return rendered.trimEnd()
}

export function upsertWeixinChannelConfig(configPath: string, entry: WeixinConfigEntry): void {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }

  const raw = readYaml<Record<string, unknown>>(configPath) ?? {}
  const channels = Array.isArray(raw.channels)
    ? (raw.channels as Array<Record<string, unknown>>)
    : []
  const nextChannel = {
    type: 'weixin',
    name: entry.name,
    accountIdRef: entry.accountIdRef,
    tokenRef: entry.tokenRef,
    ...(entry.baseUrlRef ? { baseUrlRef: entry.baseUrlRef } : {}),
    dmPolicy: 'open',
    groupPolicy: 'disabled',
  }
  const existingIndex = channels.findIndex(
    (channel) => channel.type === 'weixin' && channel.name === entry.name,
  )

  if (existingIndex >= 0) {
    channels[existingIndex] = {
      ...channels[existingIndex],
      ...nextChannel,
    }
  } else {
    channels.push(nextChannel)
  }

  writeYaml(configPath, {
    ...raw,
    channels,
  })
}

async function loginWeixinChannel(name: string, context: WeixinCliContext): Promise<boolean> {
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
    return false
  }

  const { credentials } = result
  console.log(`[ZeRo OS] Login confirmed. accountId=${credentials.accountId}`)

  let masterKey: Buffer
  try {
    masterKey = await getMasterKey()
  } catch {
    console.error('[ZeRo OS] No master key available. Run `bun zero init` first.')
    return false
  }

  const vault = new Vault(masterKey, context.secretsPath)
  const secretRefs = buildWeixinSecretRefs(name)
  vault.set(secretRefs.accountIdRef, credentials.accountId)
  vault.set(secretRefs.tokenRef, credentials.token)
  if (credentials.baseUrl) vault.set(secretRefs.baseUrlRef, credentials.baseUrl)
  vault.save()

  console.log('[ZeRo OS] Stored in vault:')
  console.log(`  ${secretRefs.accountIdRef}`)
  console.log(`  ${secretRefs.tokenRef}`)
  if (credentials.baseUrl) console.log(`  ${secretRefs.baseUrlRef}`)

  upsertWeixinChannelConfig(context.configPath, {
    name,
    accountIdRef: secretRefs.accountIdRef,
    tokenRef: secretRefs.tokenRef,
    baseUrlRef: credentials.baseUrl ? secretRefs.baseUrlRef : undefined,
  })
  console.log(`[ZeRo OS] Updated .zero/config.yaml channel "${name}"`)
  console.log('')
  console.log('Then run `bun zero restart` to activate.')
  return true
}

function buildWeixinSecretRefs(name: string): Required<WeixinConfigEntry> {
  return {
    name,
    accountIdRef: `weixin_${name}_account_id`,
    tokenRef: `weixin_${name}_token`,
    baseUrlRef: `weixin_${name}_base_url`,
  }
}

function parseNamedOption(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) return args[i + 1]
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1)
  }
  return undefined
}
