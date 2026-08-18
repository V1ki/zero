import type { ChannelCapabilities } from '@zero-os/shared'

export type { ChannelCapabilities } from '@zero-os/shared'

/**
 * Channel interface — defines the contract for all communication channels.
 */
export interface Channel {
  readonly name: string
  readonly type: string

  /**
   * Start the channel (connect, listen for events).
   */
  start(): Promise<void>

  /**
   * Stop the channel gracefully.
   */
  stop(): Promise<void>

  /**
   * Recover this channel without restarting unrelated channels.
   * Implementations may preserve channel-local delivery state across recovery.
   */
  recover?(): Promise<void>

  /**
   * Send a message through the channel.
   */
  send(sessionId: string, content: string): Promise<void>

  /**
   * Check if the channel is connected and healthy.
   */
  isConnected(): boolean

  /**
   * Set the handler for incoming messages.
   */
  setMessageHandler(handler: MessageHandler): void

  /**
   * Declare what this channel supports.
   * Injected into agent system prompt automatically.
   */
  getCapabilities(): ChannelCapabilities
}

/**
 * Incoming message from a channel.
 */
export interface ImageAttachment {
  mediaType: string
  data: string // base64
}

export interface FileAttachment {
  /** Original file name */
  fileName: string
  /** Local path where the file was saved */
  localPath: string
  /** File size in bytes */
  size: number
}

export interface IncomingMessage {
  channelType: string
  eventType?: 'message' | 'message_recalled'
  senderId: string
  content: string
  timestamp: string
  metadata?: Record<string, unknown>
  images?: ImageAttachment[]
  files?: FileAttachment[]
}

/**
 * Handler for incoming messages.
 */
export type MessageHandler = (message: IncomingMessage) => Promise<void>
