import { constants } from 'node:fs'
import { type FileHandle, lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const BLOCK_BYTES = 32 * 1024
const MAX_SCAN_BYTES = 2 * 1024 * 1024

/** Scan only the end of the file, without decoding unrelated tool output or splitting UTF-8. */
async function* tailLines(file: FileHandle, size: number): AsyncGenerator<Buffer> {
  const tail = Buffer.allocUnsafe(Math.min(size, MAX_SCAN_BYTES))
  const fileOffset = size - tail.length
  let lineEnd = tail.length
  for (let end = tail.length; end > 0; ) {
    const start = Math.max(0, end - BLOCK_BYTES)
    const { bytesRead } = await file.read(tail, start, end - start, fileOffset + start)
    if (bytesRead !== end - start) return
    // The rollout writer terminates every record with a newline. A partial last record
    // could contain a newer count for this turn.
    if (end === tail.length && tail[end - 1] !== 10) return
    for (let i = end - 1; i >= start; i--) {
      if (tail[i] !== 10) continue
      if (i + 1 < lineEnd) yield tail.subarray(i + 1, lineEnd)
      lineEnd = i
    }
    end = start
  }
  // A bounded scan may start in the middle of a JSON object.
  if (fileOffset === 0 && lineEnd > 0) yield tail.subarray(0, lineEnd)
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>
}

function readBreakdown(raw: unknown): unknown {
  const values = asObject(raw)
  if (!values) return undefined
  const usage = {
    inputTokens: values.input_tokens,
    cachedInputTokens: values.cached_input_tokens,
    cacheWriteInputTokens:
      values.cache_write_input_tokens === undefined ? 0 : values.cache_write_input_tokens,
    outputTokens: values.output_tokens,
    reasoningOutputTokens: values.reasoning_output_tokens,
    totalTokens: values.total_tokens,
  }
  if (Object.values(usage).every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0))
    return usage
}

/** Codex 0.154 persists a turn-specific running total for each metered model response. */
export async function readCodexTurnUsage(
  path: string,
  threadId: string,
  turnId: string,
): Promise<unknown | undefined> {
  if (!isAbsolute(path) || !threadId || !turnId) return undefined
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      const initial = await file.stat()
      if (!initial.isFile()) return undefined
      for await (const line of tailLines(file, initial.size)) {
        if (!line.includes('"token_usage_record"') && !line.includes('"task_started"')) continue
        const entry = asObject(JSON.parse(line.toString('utf8')))
        const payload = asObject(entry?.payload)
        if (!payload || payload.turn_id !== turnId) continue
        if (entry?.type === 'event_msg' && payload.type === 'task_started') return undefined
        if (entry?.type !== 'token_usage_record' || payload.thread_id !== threadId) continue
        const current = await lstat(path)
        if (
          current.dev !== initial.dev ||
          current.ino !== initial.ino ||
          current.size !== initial.size ||
          current.mtimeMs !== initial.mtimeMs
        )
          return undefined
        return readBreakdown(payload.turn_token_usage)
      }
    } finally {
      await file.close()
    }
  } catch (error) {
    // A missing rollout, a symlink rejected by O_NOFOLLOW, or an incomplete
    // record offers no evidence. Surface other failures to the Worker's logger.
    if (error instanceof SyntaxError) return undefined
    const code = asObject(error)?.code
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw error
  }
  return undefined
}
