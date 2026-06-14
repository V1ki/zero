import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Channel } from '@zero-os/channel'
import type { AgentSnapshot, InterruptedSessionRef, SessionManager } from '@zero-os/core'
import { collectAssistantReply, describeError } from '@zero-os/shared'
import {
  type RestartTrigger,
  consumeRestartTrigger,
  formatRestartTriggerLog,
} from '../system/restart-trigger'

interface RestartRecoveryOptions {
  restartSentinelPath: string
  sessionManager: SessionManager
  channels: Map<string, Channel>
}

interface RecordRestartSentinelOptions {
  zeroDir: string
  restartSentinelPath: string
  sessionManager: SessionManager
  channels: Map<string, Channel>
}

interface RestartSentinelEntry extends InterruptedSessionRef {
  channelId: string
  subAgents?: AgentSnapshot[]
}

interface RestartSentinelFile {
  ts: string
  trigger?: RestartTrigger
  sessions: RestartSentinelEntry[]
}

interface ResumeRestartedSessionOptions {
  entry: RestartSentinelEntry
  sessionManager: SessionManager
  channels: Map<string, Channel>
  triggerChannelId?: string
}

export async function recoverInterruptedSessionsAfterRestart({
  restartSentinelPath,
  sessionManager,
  channels,
}: RestartRecoveryOptions): Promise<void> {
  const sentinel = readAndConsumeRestartSentinel(restartSentinelPath)
  if (!sentinel) return

  if (sentinel.trigger) {
    console.log(formatRestartTriggerLog(sentinel.trigger))
    await notifyRestartTriggerComplete(sentinel.trigger, channels)
  }

  if (!Array.isArray(sentinel.sessions) || sentinel.sessions.length === 0) return

  console.log(`[ZeRo OS] Restart sentinel found ${sentinel.sessions.length} interrupted session(s)`)

  const triggerChannelId = sentinel.trigger?.channelId
  for (const entry of sentinel.sessions) {
    void resumeRestartedSession({
      entry,
      sessionManager,
      channels,
      triggerChannelId,
    })
  }
}

export async function recordRestartSentinel({
  zeroDir,
  restartSentinelPath,
  sessionManager,
  channels,
}: RecordRestartSentinelOptions): Promise<void> {
  const interruptedSessions = await sessionManager.drainAndCollectInterrupted(30_000)
  const trigger = consumeRestartTrigger(zeroDir)
  const sentinel: RestartSentinelFile = {
    ts: new Date().toISOString(),
    trigger,
    sessions: interruptedSessions.filter(isRestartSentinelEntry),
  }

  if (!trigger && sentinel.sessions.length === 0) return

  writeFileSync(restartSentinelPath, JSON.stringify(sentinel))
  console.log(
    `[ZeRo OS] Restart sentinel recorded ${sentinel.sessions.length} interrupted session(s)`,
  )

  if (sentinel.sessions.length === 0) return

  await Promise.allSettled(
    sentinel.sessions.map(async (entry) => {
      const channel = entry.channelName ? channels.get(entry.channelName) : undefined
      if (!channel || !channel.isConnected()) return

      try {
        await channel.send(entry.channelId, '🔄 ZeRo OS 正在重启...')
      } catch (error) {
        console.warn(
          `[ZeRo OS] Failed to send restart notice to ${entry.channelName ?? 'unknown'}:${entry.channelId}:`,
          describeError(error),
        )
      }
    }),
  )
}

function readAndConsumeRestartSentinel(restartSentinelPath: string): RestartSentinelFile | null {
  if (!existsSync(restartSentinelPath)) return null

  try {
    const sentinel = JSON.parse(readFileSync(restartSentinelPath, 'utf-8')) as RestartSentinelFile
    unlinkSync(restartSentinelPath)
    return sentinel
  } catch (error) {
    console.warn('[ZeRo OS] Failed to read restart sentinel:', describeError(error))
    return null
  }
}

async function notifyRestartTriggerComplete(
  trigger: RestartTrigger,
  channels: Map<string, Channel>,
): Promise<void> {
  if (!trigger.channelName || !trigger.channelId) return

  const triggerChannel = channels.get(trigger.channelName)
  if (!triggerChannel?.isConnected()) return

  try {
    await triggerChannel.send(trigger.channelId, '✅ ZeRo OS 已重启完成')
  } catch (error) {
    console.warn('[ZeRo OS] Failed to send restart completion notice:', describeError(error))
  }
}

async function resumeRestartedSession({
  entry,
  sessionManager,
  channels,
  triggerChannelId,
}: ResumeRestartedSessionOptions): Promise<void> {
  const session = sessionManager.get(entry.sessionId)
  if (!session) return
  if (
    !sessionManager.isCurrentSessionForChannel(
      entry.source,
      entry.channelId,
      entry.channelName,
      entry.sessionId,
      entry.participantId,
    )
  ) {
    return
  }

  const channel = entry.channelName ? channels.get(entry.channelName) : undefined
  if (!channel || !channel.isConnected()) return

  if (!session.getAgentConfig()) {
    console.warn(
      `[ZeRo OS] Restart sentinel skipped session without agent config: ${entry.sessionId}`,
    )
    return
  }

  try {
    session.setChannelCapabilities(channel.getCapabilities() as Record<string, unknown>)
    if (entry.subAgents?.length) {
      session.restoreSubAgentSnapshot(entry.subAgents)
    }
    if (entry.channelId !== triggerChannelId) {
      await channel.send(entry.channelId, '✅ ZeRo OS 已重启完成')
    }
    const replies = await session.handleMessage(buildRestartRecoveryMessage(entry))
    const replyText = collectAssistantReply(replies)
    if (replyText) {
      await channel.send(entry.channelId, replyText)
    }
  } catch (error) {
    console.warn(
      `[ZeRo OS] Restart sentinel failed to resume session ${entry.sessionId}:`,
      describeError(error),
    )
  }
}

function buildRestartRecoveryMessage(entry: RestartSentinelEntry): string {
  let systemMessage = '[System] The process restarted while your previous turn was still running.'

  if (entry.subAgents?.length) {
    const completed = entry.subAgents.filter((agent) => agent.state === 'completed')
    const running = entry.subAgents.filter(
      (agent) => agent.state === 'running' || agent.state === 'waiting',
    )
    const failed = entry.subAgents.filter((agent) => agent.state === 'failed')

    systemMessage += '\n\nSub-agent state at restart:'
    systemMessage += `\n- ${completed.length} completed (outputs preserved, accessible via wait_agent)`
    systemMessage += `\n- ${running.length} were still running/waiting (marked as failed, need re-spawn)`
    systemMessage += `\n- ${failed.length} had already failed`

    if (running.length > 0) {
      systemMessage += '\n\nLost sub-agents that need re-spawning:'
      for (const agent of running) {
        systemMessage += `\n  - "${agent.label}" (was: ${agent.instruction.slice(0, 100)})`
      }
    }
  }

  systemMessage +=
    '\n\nContinue the interrupted task from the existing conversation context. If the task is already complete, briefly confirm completion.'

  if (entry.subAgents?.length) {
    systemMessage +=
      ' For completed sub-agents, use wait_agent with their original IDs to retrieve results. For lost sub-agents, re-spawn them.'
  }

  return systemMessage
}

function isRestartSentinelEntry(session: InterruptedSessionRef): session is RestartSentinelEntry {
  return typeof session.channelId === 'string' && session.source !== 'scheduler'
}
