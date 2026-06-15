import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message, MessageChannelSource } from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'

export interface SessionImageAttachment {
  mediaType: string
  data: string
}

export interface SessionImageDelegationFile {
  path: string
  mediaType: string
}

export interface SessionTailRollbackRemovedMessage {
  index: number
  id: string
  role: Message['role']
  messageType: Message['messageType']
  controlKind?: Message['controlKind']
  createdAt: string
  preview: string
}

export function saveImagesForDelegation(
  images: SessionImageAttachment[] | undefined,
  workspacePath: string,
): SessionImageDelegationFile[] | undefined {
  if (!images?.length) return undefined

  const imageDir = join(workspacePath, 'incoming-images')
  if (!existsSync(imageDir)) {
    mkdirSync(imageDir, { recursive: true })
  }

  return images.map((image, index) => {
    const extension = extensionForMediaType(image.mediaType)
    const filePath = join(imageDir, `${now().replace(/[:.]/g, '-')}-${index + 1}.${extension}`)
    writeFileSync(filePath, Buffer.from(image.data, 'base64'))
    return { path: filePath, mediaType: image.mediaType }
  })
}

export function createUserMessage(options: {
  sessionId: string
  text: string
  createdAt: string
  images?: SessionImageAttachment[]
  source?: MessageChannelSource
  messageType?: Message['messageType']
}): Message {
  const content: Message['content'] = []
  if (options.text.trim().length > 0) {
    content.push({ type: 'text', text: options.text })
  }
  if (options.images?.length) {
    for (const image of options.images) {
      content.push({ type: 'image', mediaType: image.mediaType, data: image.data })
    }
  }

  const message: Message = {
    id: generateId(),
    sessionId: options.sessionId,
    role: 'user',
    messageType: options.messageType ?? 'message',
    content,
    createdAt: options.createdAt,
  }

  if (options.source) {
    message.source = options.source
  }

  return message
}

export function applyFailedTurnRollback(options: {
  messages: Message[]
  messageCountBefore: number
  onRollback: () => void
  onPartialFailure: () => void
}): boolean {
  let rolledBack = true
  if (options.messages.length <= options.messageCountBefore) {
    return rolledBack
  }

  const added = options.messages.slice(options.messageCountBefore)
  const hasCompletedWork = added.some(
    (message) => message.role === 'assistant' && message.messageType === 'message',
  )

  if (!hasCompletedWork) {
    options.messages.length = options.messageCountBefore
    for (const message of added) {
      if (message.messageType === 'queued') {
        options.messages.push(message)
      }
    }
    options.onRollback()
    return rolledBack
  }

  rolledBack = false
  options.onPartialFailure()
  return rolledBack
}

export function summarizeRollbackMessage(
  message: Message,
  index: number,
): SessionTailRollbackRemovedMessage {
  return {
    index,
    id: message.id,
    role: message.role,
    messageType: message.messageType,
    ...(message.controlKind ? { controlKind: message.controlKind } : {}),
    createdAt: message.createdAt,
    preview: buildRollbackPreview(message),
  }
}

export function buildRollbackPreview(message: Message): string {
  const parts = message.content.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'tool_use') return `tool_use:${block.name}:${block.id}`
    if (block.type === 'tool_result') {
      const text = block.outputSummary ?? block.content
      return `tool_result:${block.toolUseId}:${text}`
    }
    if (block.type === 'image') return `image:${block.mediaType}`
    if (block.type === 'thinking') return 'thinking'
    return 'unknown'
  })
  const preview = parts.join(' ').replace(/\s+/g, ' ').trim()
  return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview
}

export function isTopLevelUserTurn(message: Message): boolean {
  if (message.role !== 'user') return false
  if (message.messageType !== 'message') return false
  if (message.content.some((block) => block.type === 'tool_result')) return false

  return message.content.some((block) => block.type === 'text' || block.type === 'image')
}

export function findToolNameByUseId(messages: Message[], toolUseId: string): string | undefined {
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      if (block.id === toolUseId && typeof block.name === 'string') {
        return block.name.toLowerCase()
      }
    }
  }

  return undefined
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    default:
      return 'bin'
  }
}
