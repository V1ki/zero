import type { MetricsDB } from '@zero-os/observe'
import type { ChannelCapabilities, SessionSource } from '@zero-os/shared'
import type { SessionManager } from '../session/manager'

/** Parsed command arguments - flexible key-value */
export type CommandArgs = Record<string, unknown>

/** Context available to every command handler */
export interface CommandContext {
  /** Message source channel type */
  source: SessionSource
  /** Channel instance name */
  channelName: string
  /** Chat/conversation ID */
  chatId: string
  /** Sender user ID */
  senderId: string
  /** Platform message ID (for reply threading) */
  messageId?: string | number
  /** Extra platform metadata */
  metadata?: Record<string, unknown>
  /** Session manager */
  sessionManager: SessionManager
  /** Metrics database for session usage lookups */
  metrics?: MetricsDB
  /** Agent configuration for session initialization */
  agentConfig?: {
    name: string
    agentInstruction: string
  }
  /** Channel capabilities to set on new sessions */
  channelCapabilities?: ChannelCapabilities
  /** Send a reply to the user */
  reply(text: string): Promise<void>
}

/** Result of command execution */
export interface CommandResult {
  /** Text reply to send (if any) */
  reply?: string
  /** Whether the command was fully handled (don't pass to AI) */
  handled: boolean
}

/** A slash command definition */
export interface Command {
  /** Primary name, e.g. '/new' */
  name: string
  /** Alternative triggers */
  aliases?: string[]
  /** Human-readable description */
  description: string
  /** Restrict to specific channel sources. undefined = all sources */
  sources?: SessionSource[]
  /** Parse raw message content. Return null if not matching this command. */
  parse(content: string): CommandArgs | null
  /** Execute the command */
  execute(args: CommandArgs, ctx: CommandContext): Promise<CommandResult>
}
