import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type * as lark from '@larksuiteoapi/node-sdk'
import type { IncomingMessage } from '../base'
import { FeishuConnectionState } from '../feishu'
import { FeishuIncomingMessageBuilder } from '../feishu/incoming-message'
import { FeishuChannel } from '../feishu/index'
import { parseInteractiveCardContent } from '../feishu/interactive-card-parser'
import { TelegramChannel } from '../telegram'

type RecordedArgs = unknown[]
const tempDirs: string[] = []

interface TelegramIncomingPayload {
  from?: { id?: number; username?: string; first_name?: string }
  chat?: { id?: number; type?: string }
  message?: {
    date?: number
    message_id?: number
    caption?: string
    photo?: Array<{ file_id?: string; width?: number; height?: number }>
    video?: { file_id?: string }
    document?: { file_id?: string; mime_type?: string }
  }
}

interface TelegramTestHarness {
  bot: {
    telegram: {
      sendMessage?: (...args: unknown[]) => Promise<unknown>
      editMessageText?: (...args: unknown[]) => Promise<unknown>
      sendChatAction?: (...args: unknown[]) => Promise<unknown>
      setMessageReaction?: (...args: unknown[]) => Promise<unknown>
      setMyCommands?: (...args: unknown[]) => Promise<unknown>
      getMyCommands?: () => Promise<Array<{ command?: string; description?: string }>>
      setChatMenuButton?: (...args: unknown[]) => Promise<unknown>
      getChatMenuButton?: () => Promise<{
        type?: string
        text?: string
        web_app?: { url?: string }
      }>
      getFile?: (fileId: string) => Promise<{ file_id?: string; file_path?: string }>
      getFileLink?: (file: unknown) => Promise<URL>
    }
  } | null
  buildIncomingMessage(payload: TelegramIncomingPayload): Promise<IncomingMessage>
}

interface FeishuBinaryResponseLike {
  headers?: Record<string, string>
  getReadableStream: () => Readable
}

interface FeishuIncomingPayload {
  sender?: { sender_id?: { open_id?: string } }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    create_time?: string
    content?: string
    parent_id?: string
  }
}

interface FeishuMessageResourcePayload {
  path: { message_id: string; file_key: string }
  params: { type: 'image' | 'file' }
}

interface FeishuMessageCreatePayload {
  data: {
    receive_id?: string
    msg_type?: string
    content?: string
  }
  params?: {
    receive_id_type?: string
  }
}

interface FeishuMessageReplyPayload {
  path: { message_id: string }
  data: {
    content: string
    msg_type: string
  }
}

interface FeishuImageCreatePayload {
  data: {
    image_type?: string
    image?: Readable
  }
}

interface FeishuCardCreateResponse {
  data?: { card_id?: string }
}

interface FeishuCardUpdatePayload {
  data: { card: { data: string } }
}

interface FeishuCardElementContentPayload {
  data: { content: string }
}

interface FeishuTestHarness {
  client: {
    im: {
      image?: {
        create?: (
          payload: FeishuImageCreatePayload,
        ) => Promise<{ data?: { image_key?: string }; image_key?: string }>
      }
      messageResource?: {
        get?: (payload: FeishuMessageResourcePayload) => Promise<FeishuBinaryResponseLike>
      }
      message?: {
        create?: (payload: FeishuMessageCreatePayload) => Promise<unknown>
        reply?: (payload: FeishuMessageReplyPayload) => Promise<unknown>
        delete?: (payload: { path: { message_id: string } }) => Promise<void>
      }
      messageReaction?: {
        create?: (payload: {
          path: { message_id: string }
          data: { reaction_type: { emoji_type: string } }
        }) => Promise<{ reaction_id?: string }>
        delete?: (payload: {
          path: { message_id: string; reaction_id: string }
        }) => Promise<void>
      }
    }
    cardkit?: {
      v1: {
        card: {
          create?: () => Promise<FeishuCardCreateResponse>
          update?: (payload: FeishuCardUpdatePayload) => Promise<void>
        }
        cardElement: {
          content?: (payload: FeishuCardElementContentPayload) => Promise<void>
        }
      }
    }
    request?: (opts: unknown) => Promise<unknown>
  } | null
}

function getTelegramHarness(channel: TelegramChannel): TelegramTestHarness {
  return channel as unknown as TelegramTestHarness
}

function getFeishuHarness(channel: FeishuChannel): FeishuTestHarness {
  return channel as unknown as FeishuTestHarness
}

function buildFeishuIncomingMessage(
  channel: FeishuChannel,
  payload: FeishuIncomingPayload,
  downloadsDir?: string,
): Promise<IncomingMessage | null> {
  return new FeishuIncomingMessageBuilder({
    getClient: () => getFeishuHarness(channel).client as unknown as lark.Client | null,
    downloadsDir,
  }).build(payload)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('TelegramChannel contract', () => {
  test('name is telegram and type is telegram', () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })
    expect(channel.name).toBe('telegram')
    expect(channel.type).toBe('telegram')
  })

  test('initial isConnected is false', () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })
    expect(channel.isConnected()).toBe(false)
  })

  test('capabilities reflect disabled streaming config', () => {
    const channel = new TelegramChannel({ botToken: 'test-token', streaming: false })
    expect(channel.getCapabilities().streaming).toBe(false)
  })

  test('reply sends message with reply_parameters', async () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })
    const calls: RecordedArgs[] = []
    getTelegramHarness(channel).bot = {
      telegram: {
        sendMessage: async (...args: unknown[]) => {
          calls.push(args)
        },
      },
    }

    await channel.reply('123', 456, '👀')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      123,
      '👀',
      {
        entities: [],
        reply_parameters: {
          message_id: 456,
        },
      },
    ])
  })

  test('editRich edits existing message with entities', async () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })
    const calls: RecordedArgs[] = []
    getTelegramHarness(channel).bot = {
      telegram: {
        editMessageText: async (...args: unknown[]) => {
          calls.push(args)
          return true
        },
      },
    }

    await channel.editRich('123', 9, '**bold**')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      123,
      9,
      undefined,
      'bold',
      {
        entities: [{ type: 'bold', offset: 0, length: 4 }],
      },
    ])
  })

  test('sendTyping sends typing chat action', async () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })
    const calls: RecordedArgs[] = []
    getTelegramHarness(channel).bot = {
      telegram: {
        sendChatAction: async (...args: unknown[]) => {
          calls.push(args)
          return true
        },
      },
    }

    await channel.sendTyping('123')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([123, 'typing'])
  })

  test('react sends message reaction', async () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })
    const calls: RecordedArgs[] = []
    getTelegramHarness(channel).bot = {
      telegram: {
        setMessageReaction: async (...args: unknown[]) => {
          calls.push(args)
          return true
        },
      },
    }

    await channel.react('123', 456, '👀')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([123, 456, [{ type: 'emoji', emoji: '👀' }]])
  })

  test('setMyCommands maps scope and language_code', async () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })
    const calls: RecordedArgs[] = []
    getTelegramHarness(channel).bot = {
      telegram: {
        setMyCommands: async (...args: unknown[]) => {
          calls.push(args)
          return true
        },
      },
    }

    await channel.setMyCommands([{ command: 'restart', description: 'Restart service' }], {
      scope: {
        type: 'chat_member',
        chatId: 123,
        userId: 42,
      },
      languageCode: '',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      [{ command: 'restart', description: 'Restart service' }],
      {
        scope: {
          type: 'chat_member',
          chat_id: 123,
          user_id: 42,
        },
        language_code: '',
      },
    ])
  })

  test('getMyCommands returns normalized commands', async () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })
    getTelegramHarness(channel).bot = {
      telegram: {
        getMyCommands: async () => [
          { command: 'new', description: 'Start new chat', ignored: true },
          { command: 'model', description: 'Switch model' },
        ],
      },
    }

    const commands = await channel.getMyCommands()
    expect(commands).toEqual([
      { command: 'new', description: 'Start new chat' },
      { command: 'model', description: 'Switch model' },
    ])
  })

  test('setChatMenuButton maps web_app url payload', async () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })
    const calls: RecordedArgs[] = []
    getTelegramHarness(channel).bot = {
      telegram: {
        setChatMenuButton: async (...args: unknown[]) => {
          calls.push(args)
          return true
        },
      },
    }

    await channel.setChatMenuButton({
      chatId: 123,
      menuButton: {
        type: 'web_app',
        text: 'Open',
        webAppUrl: 'https://example.com/app',
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      {
        chatId: 123,
        menuButton: {
          type: 'web_app',
          text: 'Open',
          web_app: {
            url: 'https://example.com/app',
          },
        },
      },
    ])
  })

  test('getChatMenuButton maps web_app response', async () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })
    getTelegramHarness(channel).bot = {
      telegram: {
        getChatMenuButton: async () => ({
          type: 'web_app',
          text: 'Open',
          web_app: {
            url: 'https://example.com/app',
          },
        }),
      },
    }

    const button = await channel.getChatMenuButton()
    expect(button).toEqual({
      type: 'web_app',
      text: 'Open',
      webAppUrl: 'https://example.com/app',
    })
  })

  test('message handler keeps caption and downloads highest-resolution photo', async () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })

    const requestedFileIds: string[] = []
    const requestedUrls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requestedUrls.push(String(input))
        return new Response(Buffer.from('img-binary'), { status: 200 })
      },
      { preconnect: originalFetch.preconnect },
    )
    getTelegramHarness(channel).bot = {
      telegram: {
        getFile: async (fileId: string) => {
          requestedFileIds.push(fileId)
          return {
            file_id: fileId,
            file_path: 'photos/pic.jpg',
          }
        },
        getFileLink: async () => new URL('https://api.telegram.org/file/bot-token/photos/pic.jpg'),
      },
    }

    try {
      const msg = await getTelegramHarness(channel).buildIncomingMessage({
        from: { id: 1, username: 'u', first_name: 'n' },
        chat: { id: 123, type: 'private' },
        message: {
          date: 1,
          message_id: 10,
          caption: 'look',
          photo: [
            { file_id: 'small', width: 100, height: 80 },
            { file_id: 'large', width: 1200, height: 800 },
          ],
        },
      })

      expect(requestedFileIds).toEqual(['large'])
      expect(requestedUrls).toEqual(['https://api.telegram.org/file/bot-token/photos/pic.jpg'])
      expect(msg.content).toBe('look')
      expect(msg.images?.length).toBe(1)
      expect(msg.images?.[0].mediaType).toBe('image/jpeg')
      expect(typeof msg.images?.[0].data).toBe('string')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('message handler sets media hint for non-image media', async () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })
    getTelegramHarness(channel).bot = {
      telegram: {
        getFile: async () => ({ file_path: '' }),
        getFileLink: async () => new URL('https://api.telegram.org/file/bot-token/unused'),
      },
    }

    const msg = await getTelegramHarness(channel).buildIncomingMessage({
      from: { id: 2, username: 'u2', first_name: 'n2' },
      chat: { id: 456, type: 'private' },
      message: {
        date: 2,
        message_id: 11,
        video: { file_id: 'v1' },
      },
    })

    expect(msg.content).toBe('[video]')
    expect(msg.images).toBeUndefined()
    expect(msg.metadata?.hasMedia).toBe(true)
  })

  test('extractImages supports image document mime type', async () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })

    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async () => new Response(Buffer.from('png-binary'), { status: 200 }),
      {
        preconnect: originalFetch.preconnect,
      },
    )
    getTelegramHarness(channel).bot = {
      telegram: {
        getFile: async () => ({ file_path: 'docs/pic.png' }),
        getFileLink: async () => new URL('https://api.telegram.org/file/bot-token/docs/pic.png'),
      },
    }

    try {
      const msg = await getTelegramHarness(channel).buildIncomingMessage({
        from: { id: 3 },
        chat: { id: 789, type: 'private' },
        message: {
          date: 3,
          message_id: 12,
          document: { file_id: 'doc1', mime_type: 'image/png' },
        },
      })

      expect(msg.images?.length).toBe(1)
      expect(msg.images?.[0].mediaType).toBe('image/png')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('buildIncomingMessage is robust when from/chat/date are missing', async () => {
    const channel = new TelegramChannel({ botToken: 'test-token' })
    getTelegramHarness(channel).bot = {
      telegram: {
        getFile: async () => ({ file_path: '' }),
        getFileLink: async () => new URL('https://api.telegram.org/file/bot-token/unused'),
      },
    }

    const msg = await getTelegramHarness(channel).buildIncomingMessage({
      message: {
        message_id: 13,
        caption: 'fallback',
      },
    })

    expect(msg.senderId).toBe('unknown')
    expect(msg.content).toBe('fallback')
    expect(typeof msg.timestamp).toBe('string')
  })
})

describe('FeishuChannel contract', () => {
  test('name is feishu and type is feishu', () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    expect(channel.name).toBe('feishu')
    expect(channel.type).toBe('feishu')
  })

  test('initial isConnected is false', () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    expect(channel.isConnected()).toBe(false)
  })

  test('react and removeReaction delegate to messageReaction API', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const creates: unknown[] = []
    const deletes: unknown[] = []
    getFeishuHarness(channel).client = {
      im: {
        messageReaction: {
          create: async (payload) => {
            creates.push(payload)
            return { reaction_id: 'reaction-1' }
          },
          delete: async (payload) => {
            deletes.push(payload)
          },
        },
      },
    }

    const reactionId = await channel.react('msg-1', 'Typing')
    await channel.removeReaction('msg-1', reactionId ?? '')

    expect(reactionId).toBe('reaction-1')
    expect(creates).toEqual([
      {
        path: { message_id: 'msg-1' },
        data: { reaction_type: { emoji_type: 'Typing' } },
      },
    ])
    expect(deletes).toEqual([{ path: { message_id: 'msg-1', reaction_id: 'reaction-1' } }])
  })

  test('connection state follows websocket sdk log transitions', () => {
    const connectionState = new FeishuConnectionState()

    connectionState.updateFromSdkLog('debug', '[ws] | ws connect success')
    expect(connectionState.isConnected()).toBe(true)

    connectionState.updateFromSdkLog('error', '[ws] | timeout of 15000ms exceeded')
    expect(connectionState.isConnected()).toBe(false)

    connectionState.updateFromSdkLog('debug', '[ws] | reconnect success')
    expect(connectionState.isConnected()).toBe(true)

    connectionState.updateFromSdkLog('debug', '[ws] | client closed')
    expect(connectionState.isConnected()).toBe(false)
  })

  test('buildIncomingMessage downloads standalone image via messageResource', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const calls: FeishuMessageResourcePayload[] = []
    getFeishuHarness(channel).client = {
      im: {
        messageResource: {
          get: async (payload: FeishuMessageResourcePayload) => {
            calls.push(payload)
            return {
              headers: { 'content-type': 'image/jpeg' },
              getReadableStream: () => Readable.from([Buffer.from('fake-image')]),
            }
          },
        },
      },
    }

    const msg = await buildFeishuIncomingMessage(channel, {
      sender: { sender_id: { open_id: 'ou_test' } },
      message: {
        message_id: 'om_test',
        chat_id: 'chat_test',
        chat_type: 'p2p',
        message_type: 'image',
        create_time: '1710000000',
        content: JSON.stringify({ image_key: 'img_v3_test' }),
      },
    })
    if (!msg) {
      throw new Error('expected Feishu message')
    }

    expect(calls).toEqual([
      {
        path: { message_id: 'om_test', file_key: 'img_v3_test' },
        params: { type: 'image' },
      },
    ])
    expect(msg).toMatchObject({
      channelType: 'feishu',
      senderId: 'ou_test',
      content: '',
      metadata: {
        chatId: 'chat_test',
        messageId: 'om_test',
        chatType: 'p2p',
      },
    })
    expect(msg.images).toEqual([
      {
        mediaType: 'image/jpeg',
        data: Buffer.from('fake-image').toString('base64'),
      },
    ])
  })

  test('buildIncomingMessage downloads file messages into agent workspace uploads', async () => {
    const uploadsDir = mkdtempSync(join(tmpdir(), 'feishu-uploads-'))
    tempDirs.push(uploadsDir)

    const channel = new FeishuChannel({
      appId: 'test-id',
      appSecret: 'test-secret',
      downloadsDir: uploadsDir,
    })
    const calls: FeishuMessageResourcePayload[] = []
    getFeishuHarness(channel).client = {
      im: {
        messageResource: {
          get: async (payload: FeishuMessageResourcePayload) => {
            calls.push(payload)
            return {
              getReadableStream: () => Readable.from([Buffer.from('fake-pdf-content')]),
            }
          },
        },
      },
    }

    const msg = await buildFeishuIncomingMessage(
      channel,
      {
        sender: { sender_id: { open_id: 'ou_file' } },
        message: {
          message_id: 'om_file',
          chat_id: 'chat_file',
          chat_type: 'p2p',
          message_type: 'file',
          create_time: '1710000000',
          content: JSON.stringify({
            file_key: 'file_v3_test',
            file_name: 'Quarterly Report.pdf',
          }),
        },
      },
      uploadsDir,
    )
    if (!msg) {
      throw new Error('expected Feishu message')
    }

    expect(calls).toEqual([
      {
        path: { message_id: 'om_file', file_key: 'file_v3_test' },
        params: { type: 'file' },
      },
    ])
    expect(msg.files).toHaveLength(1)
    expect(msg.files?.[0]?.fileName).toBe('Quarterly Report.pdf')
    expect(msg.files?.[0]?.size).toBe(Buffer.from('fake-pdf-content').length)

    const localPath = msg.files?.[0]?.localPath
    if (!localPath) {
      throw new Error('expected downloaded local path')
    }

    expect(localPath.startsWith(uploadsDir)).toBe(true)
    expect(existsSync(localPath)).toBe(true)
    expect(readFileSync(localPath, 'utf8')).toBe('fake-pdf-content')
    expect(msg.content).toBe('[文件: Quarterly Report.pdf]')
  })

  test('buildIncomingMessage marks image download failure explicitly', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const originalConsoleError = console.error
    const errors: unknown[][] = []

    console.error = (...args: unknown[]) => {
      errors.push(args)
    }
    getFeishuHarness(channel).client = {
      im: {
        messageResource: {
          get: async () => {
            const error = new Error('Request failed with status code 400') as Error & {
              response?: { status: number; headers: Record<string, string> }
              config?: { method: string; url: string }
            }
            error.response = {
              status: 400,
              headers: { 'x-request-id': 'req_test' },
            }
            error.config = {
              method: 'get',
              url: 'https://open.feishu.cn/open-apis/im/v1/images/img_v3_test',
            }
            throw error
          },
        },
      },
    }

    try {
      const msg = await buildFeishuIncomingMessage(channel, {
        sender: { sender_id: { open_id: 'ou_test' } },
        message: {
          message_id: 'om_test',
          chat_id: 'chat_test',
          chat_type: 'p2p',
          message_type: 'image',
          create_time: '1710000000',
          content: JSON.stringify({ image_key: 'img_v3_test' }),
        },
      })
      if (!msg) {
        throw new Error('expected Feishu message')
      }

      expect(msg.images).toBeUndefined()
      expect(msg.content).toBe('[图片下载失败]')
      expect(errors).toEqual([
        [
          '[FeishuChannel] Failed to download image message:',
          'status=400 | request_id=req_test | GET https://open.feishu.cn/open-apis/im/v1/images/img_v3_test | Request failed with status code 400',
        ],
      ])
    } finally {
      console.error = originalConsoleError
    }
  })

  test('buildIncomingMessage strips image placeholder text when post image download succeeds', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    getFeishuHarness(channel).client = {
      im: {
        messageResource: {
          get: async () => ({
            headers: { 'content-type': 'image/png' },
            getReadableStream: () => Readable.from([Buffer.from('fake-post-image')]),
          }),
        },
      },
    }

    const msg = await buildFeishuIncomingMessage(channel, {
      sender: { sender_id: { open_id: 'ou_test' } },
      message: {
        message_id: 'om_post',
        chat_id: 'chat_test',
        chat_type: 'p2p',
        message_type: 'post',
        create_time: '1710000000',
        content: JSON.stringify({
          zh_cn: {
            content: [
              [{ tag: 'img', image_key: 'img_v3_test' }],
              [{ tag: 'text', text: '分析下这个页面' }],
            ],
          },
        }),
      },
    })
    if (!msg) {
      throw new Error('expected Feishu message')
    }

    expect(msg.content).toBe('分析下这个页面')
    expect(msg.images).toEqual([
      {
        mediaType: 'image/png',
        data: Buffer.from('fake-post-image').toString('base64'),
      },
    ])
  })

  test('parseInteractiveCardContent extracts text from cardkit v2 cards', () => {
    const parsed = parseInteractiveCardContent(
      JSON.stringify({
        schema: '2.0',
        header: {
          title: { tag: 'plain_text', content: '引用标题' },
        },
        body: {
          elements: [
            { tag: 'markdown', content: '第一段' },
            {
              tag: 'column_set',
              columns: [
                {
                  elements: [{ tag: 'markdown', content: '第二段' }],
                },
              ],
            },
          ],
        },
      }),
    )

    expect(parsed).toBe('# 引用标题\n\n第一段\n\n第二段')
  })

  test('parseInteractiveCardContent avoids duplicate text for nested cardkit nodes', () => {
    const parsed = parseInteractiveCardContent(
      JSON.stringify({
        schema: '2.0',
        body: {
          elements: [
            {
              tag: 'markdown',
              content: '只保留一次',
              elements: [{ tag: 'markdown', content: '不应重复提取' }],
            },
          ],
        },
      }),
    )

    expect(parsed).toBe('只保留一次')
  })

  test('parseInteractiveCardContent handles wrapped and legacy cards', () => {
    const wrapped = parseInteractiveCardContent(
      JSON.stringify({
        type: 'interactive',
        card: {
          schema: '2.0',
          body: {
            elements: [{ tag: 'markdown', content: '包裹卡片正文' }],
          },
        },
      }),
    )
    expect(wrapped).toBe('包裹卡片正文')

    const legacy = parseInteractiveCardContent(
      JSON.stringify({
        header: {
          title: { content: 'Legacy 标题' },
        },
        config: {},
        elements: [
          { tag: 'div', text: { content: 'Legacy 正文' } },
          {
            tag: 'note',
            elements: [{ tag: 'plain_text', content: '补充说明' }],
          },
        ],
      }),
    )
    expect(legacy).toBe('# Legacy 标题\n\nLegacy 正文\n\n补充说明')
  })

  test('parseInteractiveCardContent ignores non-visible legacy content fields', () => {
    expect(
      parseInteractiveCardContent(
        JSON.stringify({
          config: {},
          elements: [{ tag: 'action', content: 'callback_action_id' }],
        }),
      ),
    ).toBe('[卡片消息]')
  })

  test('parseInteractiveCardContent degrades for unsupported or empty cards', () => {
    expect(
      parseInteractiveCardContent(JSON.stringify({ type: 'card', data: { card_id: 'card_v1' } })),
    ).toBe('[卡片消息]')
    expect(
      parseInteractiveCardContent(
        JSON.stringify({ type: 'template', data: { template_id: 'tpl_v1' } }),
      ),
    ).toBe('[卡片消息]')
    expect(
      parseInteractiveCardContent(JSON.stringify({ schema: '2.0', body: { elements: [] } })),
    ).toBe('[卡片消息]')
    expect(parseInteractiveCardContent('not json')).toBe('[卡片消息]')
  })

  test('buildIncomingMessage injects quoted interactive card content into reply text', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    getFeishuHarness(channel).client = {
      im: {},
      request: async () => ({
        code: 0,
        data: {
          items: [
            {
              msg_type: 'interactive',
              body: {
                content: JSON.stringify({
                  schema: '2.0',
                  body: {
                    elements: [{ tag: 'markdown', content: '之前的回复内容' }],
                  },
                }),
              },
            },
          ],
        },
      }),
    }

    const msg = await buildFeishuIncomingMessage(channel, {
      sender: { sender_id: { open_id: 'ou_test' } },
      message: {
        message_id: 'om_reply',
        chat_id: 'chat_test',
        chat_type: 'p2p',
        message_type: 'text',
        create_time: '1710000000',
        content: JSON.stringify({ text: '用户的回复' }),
        parent_id: 'om_quoted',
      },
    })
    if (!msg) {
      throw new Error('expected Feishu message')
    }

    expect(msg.content).toBe('> 引用: 之前的回复内容\n\n用户的回复')
    expect(msg.metadata).toMatchObject({
      parentId: 'om_quoted',
    })
  })

  test('send uses interactive JSON 2.0 card first', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const calls: FeishuMessageCreatePayload[] = []
    getFeishuHarness(channel).client = {
      im: {
        message: {
          create: async (payload: FeishuMessageCreatePayload) => {
            calls.push(payload)
          },
        },
      },
    }

    await channel.send('chat-1', 'hello')

    expect(calls).toHaveLength(1)
    const interactiveContent = calls[0].data.content
    if (!interactiveContent) {
      throw new Error('expected interactive content')
    }
    expect(calls[0].params).toEqual({ receive_id_type: 'chat_id' })
    expect(calls[0].data.receive_id).toBe('chat-1')
    expect(calls[0].data.msg_type).toBe('interactive')
    expect(JSON.parse(interactiveContent)).toEqual({
      schema: '2.0',
      body: {
        direction: 'vertical',
        elements: [{ tag: 'markdown', content: 'hello' }],
      },
    })
  })

  test('send falls back to text when interactive and post sends fail', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const calls: FeishuMessageCreatePayload[] = []
    getFeishuHarness(channel).client = {
      im: {
        message: {
          create: async (payload: FeishuMessageCreatePayload) => {
            calls.push(payload)
            if (payload?.data?.msg_type === 'interactive' || payload?.data?.msg_type === 'post') {
              throw new Error('rich failed')
            }
          },
        },
      },
    }

    await channel.send('chat-2', 'fallback')

    expect(calls).toHaveLength(3)
    expect(calls[0].data.msg_type).toBe('interactive')
    expect(calls[1].data.msg_type).toBe('post')
    expect(calls[2].data.msg_type).toBe('text')
  })

  test('send falls back to standalone image message when inline image cannot be embedded', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const calls: FeishuMessageCreatePayload[] = []
    const imageUploads: FeishuImageCreatePayload[] = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => new Response('fake-inline-image')) as unknown as typeof fetch
    try {
      getFeishuHarness(channel).client = {
        im: {
          image: {
            create: async (payload: FeishuImageCreatePayload) => {
              imageUploads.push(payload)
              if (imageUploads.length === 1) return {}
              return { data: { image_key: 'img_v3_fallback' } }
            },
          },
          message: {
            create: async (payload: FeishuMessageCreatePayload) => {
              calls.push(payload)
            },
          },
        },
      }

      await channel.send('chat-inline-1', 'Hello\n\n![diagram](https://example.com/demo.png)')
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(imageUploads).toHaveLength(2)
    expect(calls).toHaveLength(2)
    expect(calls[0].data.msg_type).toBe('interactive')
    expect(JSON.parse(calls[0].data.content ?? '').body.elements[0].content.trim()).toBe('Hello')
    expect(calls[1]).toEqual({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'chat-inline-1',
        msg_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_fallback' }),
      },
    })
  })

  test('reply sends interactive markdown first', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const calls: FeishuMessageReplyPayload[] = []
    getFeishuHarness(channel).client = {
      im: {
        message: {
          reply: async (payload: FeishuMessageReplyPayload) => {
            calls.push(payload)
          },
        },
      },
    }

    await channel.reply('msg-1', 'hello')

    expect(calls).toHaveLength(1)
    const interactiveContent = calls[0].data.content
    if (!interactiveContent) {
      throw new Error('expected interactive reply content')
    }
    expect(calls[0].path).toEqual({ message_id: 'msg-1' })
    expect(calls[0].data.msg_type).toBe('interactive')
    expect(JSON.parse(interactiveContent)).toEqual({
      schema: '2.0',
      body: {
        direction: 'vertical',
        elements: [{ tag: 'markdown', content: 'hello' }],
      },
    })
  })

  test('reply falls back to post when interactive reply fails', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const calls: FeishuMessageReplyPayload[] = []
    getFeishuHarness(channel).client = {
      im: {
        message: {
          reply: async (payload: FeishuMessageReplyPayload) => {
            calls.push(payload)
            if (payload?.data?.msg_type === 'interactive') {
              throw new Error('interactive failed')
            }
          },
        },
      },
    }

    await channel.reply('msg-2', 'fallback')

    expect(calls).toHaveLength(2)
    expect(calls[0].data.msg_type).toBe('interactive')
    expect(calls[1]).toEqual({
      path: { message_id: 'msg-2' },
      data: {
        content: JSON.stringify({
          zh_cn: {
            content: [[{ tag: 'md', text: 'fallback' }]],
          },
        }),
        msg_type: 'post',
      },
    })
  })

  test('reply sends visible notice when inline image embedding and fallback delivery both fail', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const calls: FeishuMessageReplyPayload[] = []
    const imageUploads: FeishuImageCreatePayload[] = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => new Response('fake-inline-image')) as unknown as typeof fetch
    try {
      getFeishuHarness(channel).client = {
        im: {
          image: {
            create: async (payload: FeishuImageCreatePayload) => {
              imageUploads.push(payload)
              return {}
            },
          },
          message: {
            reply: async (payload: FeishuMessageReplyPayload) => {
              calls.push(payload)
            },
          },
        },
      }

      await channel.reply('msg-inline-1', 'Hello\n\n![diagram](https://example.com/demo.png)')
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(imageUploads).toHaveLength(2)
    expect(calls).toHaveLength(2)
    expect(calls[0].data.msg_type).toBe('interactive')
    expect(JSON.parse(calls[0].data.content).body.elements[0].content.trim()).toBe('Hello')
    expect(calls[1].data.msg_type).toBe('interactive')
    expect(JSON.parse(calls[1].data.content).body.elements[0].content).toBe(
      '有 1 张图片未能发送，请检查图片引用或稍后重试。',
    )
  })

  test('reply falls back to text when interactive and post replies fail', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const calls: FeishuMessageReplyPayload[] = []
    getFeishuHarness(channel).client = {
      im: {
        message: {
          reply: async (payload: FeishuMessageReplyPayload) => {
            calls.push(payload)
            if (payload?.data?.msg_type === 'interactive' || payload?.data?.msg_type === 'post') {
              throw new Error('interactive failed')
            }
          },
        },
      },
    }

    await channel.reply('msg-3', 'fail-all')
    expect(calls).toHaveLength(3)
    expect(calls[0].data.msg_type).toBe('interactive')
    expect(calls[1].data.msg_type).toBe('post')
    expect(calls[2].data.msg_type).toBe('text')
  })

  test('reply throws when interactive, post and text replies all fail', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const calls: FeishuMessageReplyPayload[] = []
    getFeishuHarness(channel).client = {
      im: {
        message: {
          reply: async (payload: FeishuMessageReplyPayload) => {
            calls.push(payload)
            if (payload?.data?.msg_type === 'text') {
              throw new Error('text failed')
            }
            throw new Error('rich failed')
          },
        },
      },
    }

    await expect(channel.reply('msg-4', 'fail-all')).rejects.toThrow('text failed')
    expect(calls).toHaveLength(3)
    expect(calls[0].data.msg_type).toBe('interactive')
    expect(calls[1].data.msg_type).toBe('post')
    expect(calls[2].data.msg_type).toBe('text')
  })

  test('reply returns early when client is null', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    await expect(channel.reply('msg-5', 'no-client')).resolves.toBeUndefined()
  })

  test('streaming update does not wait for card flush completion', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const elementUpdates: string[] = []
    const finalCards: string[] = []

    let releaseFlush: (() => void) | undefined
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve
    })

    getFeishuHarness(channel).client = {
      im: {
        message: {
          create: async () => ({
            data: { message_id: 'om_stream' },
          }),
        },
      },
      cardkit: {
        v1: {
          card: {
            create: async () => ({
              data: { card_id: 'card_stream' },
            }),
            update: async (payload: {
              data: { card: { data: string } }
            }) => {
              finalCards.push(payload.data.card.data)
            },
          },
          cardElement: {
            content: async (payload: { data: { content: string } }) => {
              elementUpdates.push(payload.data.content)
              await flushGate
            },
          },
        },
      },
    }

    const session = await channel.sendStreaming('chat-1')
    const updatePromise = session.update('hello')

    const state = await Promise.race([
      updatePromise.then(() => 'resolved'),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), 20)
      }),
    ])

    expect(state).toBe('resolved')

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(elementUpdates).toEqual(['hello'])

    releaseFlush?.()
    await session.complete('hello')

    expect(finalCards).toHaveLength(1)
    expect(JSON.parse(finalCards[0])).toEqual({
      schema: '2.0',
      body: {
        elements: [
          {
            tag: 'markdown',
            content: 'hello',
            text_align: 'left',
          },
        ],
      },
    })
  })

  test('streaming dismiss deletes the attached message without finalizing the card', async () => {
    const channel = new FeishuChannel({ appId: 'test-id', appSecret: 'test-secret' })
    const deletedMessageIds: string[] = []
    const finalCards: string[] = []

    getFeishuHarness(channel).client = {
      im: {
        message: {
          create: async () => ({
            data: { message_id: 'om_stream' },
          }),
          delete: async (payload: { path: { message_id: string } }) => {
            deletedMessageIds.push(payload.path.message_id)
          },
        },
      },
      cardkit: {
        v1: {
          card: {
            create: async () => ({
              data: { card_id: 'card_stream' },
            }),
            update: async (payload: {
              data: { card: { data: string } }
            }) => {
              finalCards.push(payload.data.card.data)
            },
          },
          cardElement: {
            content: async () => undefined,
          },
        },
      },
    }

    const session = await channel.sendStreaming('chat-1')
    await session.dismiss()

    expect(deletedMessageIds).toEqual(['om_stream'])
    expect(finalCards).toEqual([])
  })
})
