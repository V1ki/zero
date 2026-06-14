import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toErrorMessage } from '@zero-os/shared'
import { writeRestartTrigger } from '../system/restart-trigger'
import { rebuildWebBundle } from '../system/runtime'

export async function runRestartCommand(options: {
  zeroDir: string
  gracePeriodSeconds: number
}): Promise<void> {
  const heartbeatPath = join(options.zeroDir, 'heartbeat.json')
  if (!existsSync(heartbeatPath)) {
    console.error('[ZeRo OS] No heartbeat file found. Is the server running?')
    process.exit(1)
  }

  try {
    const data = JSON.parse(readFileSync(heartbeatPath, 'utf-8')) as {
      pid: number
      uptime?: number
    }

    if (typeof data.uptime === 'number' && data.uptime < options.gracePeriodSeconds) {
      console.error(
        `[ZeRo OS] Refusing restart: process just started and is still in the startup grace period (${data.uptime.toFixed(1)}s < ${options.gracePeriodSeconds}s).`,
      )
      process.exit(1)
    }

    console.log('[ZeRo OS] Rebuilding web UI before restart...')
    const build = rebuildWebBundle()
    if (!build.ok) {
      console.error('[ZeRo OS] Web rebuild failed:', build.error)
      process.exit(1)
    }

    const pid = data.pid as number
    writeRestartTrigger(options.zeroDir, {
      source: 'cli',
      sessionId: process.env.ZERO_SESSION_ID,
      channelName: process.env.ZERO_CHANNEL_NAME,
      channelId: process.env.ZERO_CHANNEL_ID,
    })
    process.kill(pid, 'SIGTERM')
    console.log(`[ZeRo OS] Sent SIGTERM to PID ${pid}. Supervisor will restart the process.`)
  } catch (err) {
    console.error('[ZeRo OS] Failed to restart:', toErrorMessage(err))
    process.exit(1)
  }
}
