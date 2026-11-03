import type { ToolContext } from '@zero-os/shared'

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

export function buildToolContextEnv(ctx: ToolContext): Record<string, string> {
  return {
    ZERO_WORKSPACE: ctx.workDir,
    ZERO_PROJECT_ROOT: ctx.projectRoot ?? process.cwd(),
    ZERO_SESSION_ID: ctx.sessionId,
    ZERO_CHANNEL_NAME: ctx.channelBinding?.channelName ?? '',
    ZERO_CHANNEL_ID: ctx.channelBinding?.channelId ?? '',
  }
}

export function buildCodexServerEnv(): Record<string, string> {
  const env = processEnvironment()
  for (const key of [
    'ZERO_WORKSPACE',
    'ZERO_PROJECT_ROOT',
    'ZERO_SESSION_ID',
    'ZERO_CHANNEL_NAME',
    'ZERO_CHANNEL_ID',
  ]) {
    delete env[key]
  }
  return env
}

export function buildToolProcessEnv(ctx: ToolContext): Record<string, string> {
  const { ZERO_CHANNEL_NAME, ZERO_CHANNEL_ID, ...context } = buildToolContextEnv(ctx)
  return {
    ...processEnvironment(),
    ...context,
    ...(ZERO_CHANNEL_NAME && { ZERO_CHANNEL_NAME }),
    ...(ZERO_CHANNEL_ID && { ZERO_CHANNEL_ID }),
  }
}
