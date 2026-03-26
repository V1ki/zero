import type { Command, CommandArgs, CommandResult } from '../types'

interface NewSessionArgs extends CommandArgs {
  modelArg?: string
}

function parseNewSessionArgs(content: string): NewSessionArgs | null {
  const trimmed = content.trim()
  const match = trimmed.match(/^\/new(?:@\S+)?(?:\s+(.+))?$/i)
  if (!match) return null

  const modelArg = match[1]?.trim()
  return modelArg ? { modelArg } : {}
}

export function buildNewSessionReply(
  currentModel: string,
  modelResult?: { success: boolean; message: string },
  previousSessionId?: string,
): string {
  const prev = previousSessionId ? `\nPrevious session: ${previousSessionId}` : ''
  if (!modelResult || modelResult.success) {
    return `New conversation started with model: ${currentModel}${prev}`
  }
  return `New conversation started. ${modelResult.message}${prev}`
}

export const newSessionCommand: Command = {
  name: '/new',
  description: 'Start a brand-new session for the current channel, optionally with a model.',
  parse: parseNewSessionArgs,
  async execute(args, ctx): Promise<CommandResult> {
    if (!ctx.agentConfig) {
      return {
        handled: true,
        reply: 'Unable to start a new conversation: missing agent configuration.',
      }
    }

    const { session, previousSessionId } = ctx.sessionManager.startNewForChannel(ctx.source, ctx.chatId, {
      channelName: ctx.channelName,
    })

    if (ctx.channelCapabilities) {
      session.setChannelCapabilities(ctx.channelCapabilities)
    }

    const parsedArgs = args as NewSessionArgs
    const modelArg = typeof parsedArgs.modelArg === 'string' ? parsedArgs.modelArg.trim() : undefined
    const modelResult = modelArg ? await session.switchModel(modelArg) : undefined

    session.initAgent({
      name: ctx.agentConfig.name,
      agentInstruction: ctx.agentConfig.agentInstruction,
    })

    return {
      handled: true,
      reply: buildNewSessionReply(session.data.currentModel, modelResult, previousSessionId),
    }
  },
}
