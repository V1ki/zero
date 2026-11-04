import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TriggerNativePresence, TriggerNativePresenceSettings } from '@zero-os/shared'
import { TRIGGER_NATIVE_PRESENCE_TTL_MS } from '@zero-os/shared'

const exec = promisify(execFile)

// Return only lock and idle observations from the current GUI session. A headless
// service or an unrecognized dictionary cannot certify that the user's Mac is unlocked.
const quartz = `
ObjC.import('CoreGraphics')
const session = ObjC.castRefToObject($.CGSessionCopyCurrentDictionary())
const flag = key => ObjC.unwrap(session.objectForKey(key))
const onConsole = flag('kCGSSessionOnConsoleKey')
const loggedIn = flag('kCGSessionLoginDoneKey')
const lock = flag('CGSSessionScreenIsLocked')
let locked = null
if (onConsole === false || loggedIn === false || lock === true) locked = true
else if (onConsole === true && loggedIn === true && (lock === false || lock == null)) locked = false
const idle = $.CGEventSourceSecondsSinceLastEventType(1, 4294967295)
JSON.stringify({ locked, idleSeconds: Number.isFinite(idle) && idle >= 0 ? Math.floor(idle) : null })
`

export type NativePresenceProbe = (
  settings: TriggerNativePresenceSettings,
  signal: AbortSignal,
) => Promise<Omit<TriggerNativePresence, 'observedAt'>>

async function jsonCommand(file: string, args: string[], signal: AbortSignal): Promise<unknown> {
  try {
    const { stdout } = await exec(file, args, {
      timeout: 2500,
      killSignal: 'SIGKILL',
      signal,
      maxBuffer: 512 * 1024,
      encoding: 'utf8',
    })
    return JSON.parse(stdout)
  } catch (error) {
    // These optional system facilities can be unavailable, inaccessible, or time out.
    // Never emit stderr or raw profiler output, which can contain local device identifiers.
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && ('code' in error || 'killed' in error))
    )
      return null
    throw error
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function hasBluetoothAudio(report: unknown): boolean | null {
  if (!record(report) || !Array.isArray(report.SPAudioDataType)) return null
  const groups = report.SPAudioDataType.filter(record)
  if (!groups.some((group) => Array.isArray(group._items))) return null
  return groups.some(
    (group) =>
      Array.isArray(group._items) &&
      group._items.some(
        (device: unknown) =>
          record(device) &&
          device.coreaudio_device_transport === 'coreaudio_device_type_bluetooth' &&
          Number(device.coreaudio_device_output) > 0,
      ),
  )
}

export const probeNativePresence: NativePresenceProbe = async (settings, signal) => {
  const unknown = { locked: null, idleSeconds: null, bluetoothConnected: null }
  if (!settings.enabled || process.platform !== 'darwin' || signal.aborted) return unknown
  const [session, audio] = await Promise.all([
    jsonCommand('/usr/bin/osascript', ['-l', 'JavaScript', '-e', quartz], signal),
    settings.bluetooth
      ? jsonCommand('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], signal)
      : null,
  ])
  return {
    locked: record(session) && typeof session.locked === 'boolean' ? session.locked : null,
    idleSeconds:
      record(session) &&
      typeof session.idleSeconds === 'number' &&
      Number.isFinite(session.idleSeconds) &&
      session.idleSeconds >= 0
        ? session.idleSeconds
        : null,
    bluetoothConnected: hasBluetoothAudio(audio),
  }
}

/** No timers and no probes until an enabled policy needs a fresh decision. */
export class TriggerPresenceReader {
  private entry?: { bluetooth: boolean; at: number; result: Promise<TriggerNativePresence> }

  constructor(private probe: NativePresenceProbe = probeNativePresence) {}

  reset() {
    this.entry = undefined
  }

  read(settings: TriggerNativePresenceSettings | undefined, now: Date, signal: AbortSignal) {
    if (!settings?.enabled || signal.aborted) {
      this.reset()
      return undefined
    }
    const cached = this.entry
    const at = now.getTime()
    if (
      cached &&
      cached.bluetooth === settings.bluetooth &&
      at >= cached.at &&
      at - cached.at < TRIGGER_NATIVE_PRESENCE_TTL_MS
    )
      return cached.result
    const result = this.probe(settings, signal).then((observation) => ({
      ...observation,
      observedAt: now.toISOString(),
    }))
    this.entry = { bluetooth: settings.bluetooth, at, result }
    return result
  }
}
