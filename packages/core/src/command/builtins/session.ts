import type { MetricsDB, SessionStatsSummary } from '@zero-os/observe'
import type { Message } from '@zero-os/shared'
import { Session } from '../../session/session'
import type { Command, CommandArgs, CommandResult } from '../types'

interface SessionCommandArgs extends CommandArgs {}

interface SessionInfoTarget {
  data: {
    id: string
    currentModel: string
    createdAt: string
    updatedAt: string
  }
  getMessages(): Message[]
}

const ZERO_STATS: SessionStatsSummary = {
  totalCost: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  effectiveInputTokens: 0,
  cacheHitRate: 0,
  requestCount: 0,
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0')
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown'

  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(' ')
}

// Keep seconds in hour-level durations for the /session command's compact audit-style output.
function formatSessionDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'

  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
  }).format(Math.max(0, Math.floor(value)))
}

function formatCost(value: number): string {
  return `$${Math.max(0, value).toFixed(4)}`
}

function formatRow(label: string, value: string): string {
  return `${`${label}:`.padEnd(14)}${value}`
}

function countToolCallsFromMessages(messages: Message[]): number {
  return messages.reduce((total, message) => {
    return total + message.content.filter((block) => block.type === 'tool_use').length
  }, 0)
}

function getSessionUsageStats(
  metrics: MetricsDB | undefined,
  sessionId: string,
): SessionStatsSummary {
  return metrics?.sessionStats(sessionId) ?? ZERO_STATS
}

function buildSessionInfoBody(session: SessionInfoTarget, metrics?: MetricsDB): string {
  const messages = session.getMessages()
  const turns = messages.filter((message) => Session.isTopLevelUserTurn(message)).length
  const fallbackToolCalls = countToolCallsFromMessages(messages)
  const toolCalls = metrics
    ? Math.max(metrics.sessionToolCallCount(session.data.id), fallbackToolCalls)
    : fallbackToolCalls
  const stats = getSessionUsageStats(metrics, session.data.id)
  const durationMs =
    new Date(session.data.updatedAt).getTime() - new Date(session.data.createdAt).getTime()

  return [
    '-------------------------',
    formatRow('ID', session.data.id),
    formatRow('Model', session.data.currentModel),
    '-------------------------',
    formatRow('Created', formatTimestamp(session.data.createdAt)),
    formatRow('Updated', formatTimestamp(session.data.updatedAt)),
    formatRow('Duration', formatSessionDuration(durationMs)),
    '-------------------------',
    formatRow('Messages', formatNumber(messages.length)),
    formatRow('Turns', formatNumber(turns)),
    formatRow('Requests', formatNumber(stats.requestCount)),
    formatRow('Tool calls', formatNumber(toolCalls)),
    '-------------------------',
    formatRow(
      'Tokens',
      `${formatNumber(stats.inputTokens)} in / ${formatNumber(stats.outputTokens)} out`,
    ),
    formatRow(
      'Cache',
      `${formatNumber(stats.cacheWriteTokens)} write / ${formatNumber(stats.cacheReadTokens)} read (${Math.round(stats.cacheHitRate * 100)}% hit)`,
    ),
    formatRow('Cost', formatCost(stats.totalCost)),
  ].join('\n')
}

export function parseSessionArgs(content: string): SessionCommandArgs | null {
  return /^\/session(?:@\S+)?$/i.test(content.trim()) ? {} : null
}

export function buildSessionInfoReply(
  session: SessionInfoTarget,
  metrics?: MetricsDB,
): string {
  return ['Session Info', buildSessionInfoBody(session, metrics)].join('\n')
}

function buildFeishuSessionInfoReply(session: SessionInfoTarget, metrics?: MetricsDB): string {
  return ['Session Info', '', '```', buildSessionInfoBody(session, metrics), '```'].join('\n')
}

export const sessionCommand: Command = {
  name: '/session',
  description: 'Show the current session status and usage summary.',
  parse: parseSessionArgs,
  async execute(_args, ctx): Promise<CommandResult> {
    const { session } = ctx.sessionManager.getOrCreateForChannel(
      ctx.source,
      ctx.chatId,
      ctx.channelName,
    )

    return {
      handled: true,
      reply:
        ctx.source === 'feishu'
          ? buildFeishuSessionInfoReply(session, ctx.metrics)
          : buildSessionInfoReply(session, ctx.metrics),
    }
  },
}
