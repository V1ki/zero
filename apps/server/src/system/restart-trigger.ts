import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RestartTrigger {
  source: string
  sessionId?: string
  channelName?: string
  channelId?: string
}

interface RestartTriggerFile extends RestartTrigger {
  ts: string
}

const RESTART_TRIGGER_FILE = 'restart-trigger.json'

function getRestartTriggerPath(zeroDir: string): string {
  return join(zeroDir, RESTART_TRIGGER_FILE)
}

export function writeRestartTrigger(zeroDir: string, trigger: RestartTrigger): RestartTriggerFile {
  const payload: RestartTriggerFile = {
    source: trigger.source,
    sessionId: trigger.sessionId,
    channelName: trigger.channelName,
    channelId: trigger.channelId,
    ts: new Date().toISOString(),
  }

  writeFileSync(getRestartTriggerPath(zeroDir), JSON.stringify(payload))
  return payload
}

export function consumeRestartTrigger(zeroDir: string): RestartTrigger | undefined {
  const path = getRestartTriggerPath(zeroDir)
  if (!existsSync(path)) {
    return undefined
  }

  const payload = JSON.parse(readFileSync(path, 'utf-8')) as RestartTriggerFile
  unlinkSync(path)

  return {
    source: payload.source,
    sessionId: payload.sessionId,
    channelName: payload.channelName,
    channelId: payload.channelId,
  }
}

export function formatRestartTriggerLog(trigger: RestartTrigger): string {
  return `[ZeRo OS] Restart was triggered by ${trigger.source}${trigger.channelName ? ` (${trigger.channelName})` : ''}${trigger.sessionId ? ` session=${trigger.sessionId}` : ''}`
}
