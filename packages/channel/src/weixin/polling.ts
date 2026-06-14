import { type ApiOptions, isAbortError, postJson } from './api-transport'
import {
  BACKOFF_DELAY_MS,
  EP_GET_UPDATES,
  LONG_POLL_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  RETRY_DELAY_MS,
  SESSION_EXPIRED_ERRCODE,
  SESSION_EXPIRED_PAUSE_MS,
} from './constants'
import { loadSyncBuf, saveSyncBuf } from './storage'
import type { GetUpdatesResponse, IncomingMessage as ILinkIncomingMessage } from './types'

interface WeixinPollingLoopOptions {
  homeDir: string
  accountId: string
  baseUrl: string
  token: string
  channelName: string
  getApiOptions(): ApiOptions
  isRunning(): boolean
  sleep(ms: number): Promise<void>
  now(): number
  setSessionPausedUntil(pausedUntilMs: number): void
  processMessage(message: ILinkIncomingMessage): Promise<void>
}

export async function getUpdates(
  params: { baseUrl: string; token: string; syncBuf: string; timeoutMs?: number },
  opts: ApiOptions = {},
): Promise<GetUpdatesResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = params.timeoutMs ?? LONG_POLL_TIMEOUT_MS
  try {
    return await postJson<GetUpdatesResponse>(
      fetchImpl,
      {
        baseUrl: params.baseUrl,
        endpoint: EP_GET_UPDATES,
        payload: { get_updates_buf: params.syncBuf },
        token: params.token,
        timeoutMs,
      },
      opts,
    )
  } catch (err) {
    if (isAbortError(err)) {
      return { ret: 0, msgs: [], get_updates_buf: params.syncBuf }
    }
    throw err
  }
}

export async function runWeixinPollingLoop(options: WeixinPollingLoopOptions): Promise<void> {
  let syncBuf = loadSyncBuf(options.homeDir, options.accountId)
  let timeoutMs: number | undefined
  let consecutiveFailures = 0

  while (options.isRunning()) {
    try {
      const response = await getUpdates(
        {
          baseUrl: options.baseUrl,
          token: options.token,
          syncBuf,
          timeoutMs,
        },
        options.getApiOptions(),
      )
      const suggested = response.longpolling_timeout_ms
      if (typeof suggested === 'number' && suggested > 0) timeoutMs = suggested

      const ret = response.ret ?? 0
      const errcode = response.errcode ?? 0
      if (ret !== 0 || errcode !== 0) {
        if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) {
          options.setSessionPausedUntil(options.now() + SESSION_EXPIRED_PAUSE_MS)
          await options.sleep(SESSION_EXPIRED_PAUSE_MS)
          consecutiveFailures = 0
          continue
        }
        consecutiveFailures = await sleepAfterPollingFailure(options, consecutiveFailures)
        continue
      }

      consecutiveFailures = 0
      const newBuf = String(response.get_updates_buf ?? '')
      if (newBuf) {
        syncBuf = newBuf
        saveSyncBuf(options.homeDir, options.accountId, syncBuf)
      }

      const messages = response.msgs ?? []
      if (messages.length > 0) {
        console.log(
          `[WeixinChannel] poll returned channel=${options.channelName} messages=${messages.length}`,
        )
      }
      for (const msg of messages) {
        void options.processMessage(msg)
      }
    } catch {
      if (!options.isRunning()) break
      consecutiveFailures = await sleepAfterPollingFailure(options, consecutiveFailures)
    }
  }
}

async function sleepAfterPollingFailure(
  options: Pick<WeixinPollingLoopOptions, 'sleep'>,
  consecutiveFailures: number,
): Promise<number> {
  const nextFailures = consecutiveFailures + 1
  const delay = nextFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS
  await options.sleep(delay)
  return nextFailures >= MAX_CONSECUTIVE_FAILURES ? 0 : nextFailures
}
