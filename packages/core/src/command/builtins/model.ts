import type { Command, CommandArgs, CommandResult } from '../types'

interface ModelCommandArgs extends CommandArgs {
  target?: string
}

function parseModelArgs(content: string): ModelCommandArgs | null {
  const trimmed = content.trim()
  const match = trimmed.match(/^\/model(?:@\S+)?(?:\s+(.+))?$/i)
  if (!match) return null

  const target = match[1]?.trim()
  return target ? { target } : {}
}

export const modelCommand: Command = {
  name: '/model',
  description: 'Show current model, list available models, or switch model.',
  parse: parseModelArgs,
  async execute(args, ctx): Promise<CommandResult> {
    const { session } = ctx.sessionManager.getOrCreateForChannel(
      ctx.source,
      ctx.chatId,
      ctx.channelName,
      ctx.participantId,
    )

    const parsedArgs = args as ModelCommandArgs
    const target = typeof parsedArgs.target === 'string' ? parsedArgs.target.trim() : undefined
    if (!target) {
      return { handled: true, reply: `Current model: ${session.data.currentModel}` }
    }

    if (target.toLowerCase() === 'list') {
      const available = session
        .listModels()
        .map((model) => `- ${model}`)
        .join('\n')
      return { handled: true, reply: `Available models:\n${available}` }
    }

    const result = await session.switchModel(target)
    return { handled: true, reply: result.message }
  },
}
