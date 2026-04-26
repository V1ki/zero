import type { ReasoningEffort } from '@zero-os/shared'
import type { Command, CommandArgs, CommandResult } from '../types'

interface ThinkCommandArgs extends CommandArgs {
  effort?: string
}

const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high']
const RESET_ARGUMENTS = new Set(['off', 'default', 'reset'])

function parseThinkArgs(content: string): ThinkCommandArgs | null {
  const trimmed = content.trim()
  const match = trimmed.match(/^\/think(?:@\S+)?(?:\s+(.+))?$/i)
  if (!match) return null

  const effort = match[1]?.trim()
  return effort ? { effort } : {}
}

function normalizeReasoningEffort(value?: string): ReasoningEffort | undefined | null {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (RESET_ARGUMENTS.has(normalized)) return null
  return REASONING_EFFORTS.find((effort) => effort === normalized)
}

function formatCurrentReasoningEffort(effort?: ReasoningEffort): string {
  return effort ? `Current thinking effort: ${effort}` : 'Current thinking effort: provider default'
}

export const thinkCommand: Command = {
  name: '/think',
  description: 'Show or set session thinking effort (/think [low|medium|high|off]).',
  parse: parseThinkArgs,
  async execute(args, ctx): Promise<CommandResult> {
    const { session } = ctx.sessionManager.getOrCreateForChannel(
      ctx.source,
      ctx.chatId,
      ctx.channelName,
      ctx.participantId,
    )

    const parsedArgs = args as ThinkCommandArgs
    const rawEffort = typeof parsedArgs.effort === 'string' ? parsedArgs.effort.trim() : undefined
    if (!rawEffort) {
      return {
        handled: true,
        reply: formatCurrentReasoningEffort(session.getReasoningEffort()),
      }
    }

    const normalized = normalizeReasoningEffort(rawEffort)
    if (normalized === undefined) {
      return {
        handled: true,
        reply: 'Usage: /think [low|medium|high|off]',
      }
    }

    const result = session.setReasoningEffort(normalized ?? undefined)
    return { handled: true, reply: result.message }
  },
}
