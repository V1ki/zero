import type { Command, CommandArgs, CommandResult } from '../types'

interface ModelCommandArgs extends CommandArgs {
  target?: string
}

interface ModelListGroup {
  model: string
  members?: string[]
}

interface ModelListSession {
  listModels(): string[]
  listModelGroups?: () => ModelListGroup[]
}

function parseModelArgs(content: string): ModelCommandArgs | null {
  const trimmed = content.trim()
  const match = trimmed.match(/^\/model(?:@\S+)?(?:\s+(.+))?$/i)
  if (!match) return null

  const target = match[1]?.trim()
  return target ? { target } : {}
}

function formatAvailableModels(session: ModelListSession): string {
  const groups =
    typeof session.listModelGroups === 'function'
      ? session.listModelGroups()
      : session.listModels().map((model) => ({ model }))
  return groups.map(formatModelGroup).join('\n')
}

function formatModelGroup(group: ModelListGroup): string {
  const lines = [`- ${group.model}`]
  for (const member of group.members ?? []) {
    lines.push(`  - ${member}`)
  }
  return lines.join('\n')
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
      const available = formatAvailableModels(session)
      return { handled: true, reply: `Available models:\n${available}` }
    }

    const result = await session.switchModel(target)
    return { handled: true, reply: result.message }
  },
}
