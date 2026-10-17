import type { ToolContext } from '@zero-os/shared'

export function buildToolProcessEnv(ctx: ToolContext): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )

  env.ZERO_WORKSPACE = ctx.workDir
  env.ZERO_PROJECT_ROOT = ctx.projectRoot ?? process.cwd()
  env.ZERO_SESSION_ID = ctx.sessionId

  if (ctx.channelBinding?.channelName) {
    env.ZERO_CHANNEL_NAME = ctx.channelBinding.channelName
  }

  if (ctx.channelBinding?.channelId) {
    env.ZERO_CHANNEL_ID = ctx.channelBinding.channelId
  }

  return env
}
