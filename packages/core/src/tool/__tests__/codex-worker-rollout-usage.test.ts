import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCodexTurnUsage } from '../worker/codex-worker-rollout-usage'

let dir: string
let path: string
const thread = 'thread-a'
const turn = 'turn-a'
const counts = {
  input_tokens: 180,
  cached_input_tokens: 20,
  cache_write_input_tokens: 10,
  output_tokens: 12,
  reasoning_output_tokens: 2,
  total_tokens: 192,
}
const expected = {
  inputTokens: 180,
  cachedInputTokens: 20,
  cacheWriteInputTokens: 10,
  outputTokens: 12,
  reasoningOutputTokens: 2,
  totalTokens: 192,
}
function record(usage: unknown = counts, threadId = thread, turnId = turn) {
  return {
    type: 'token_usage_record',
    payload: {
      thread_id: threadId,
      turn_id: turnId,
      usage: { ...counts, input_tokens: 7 },
      thread_token_usage: { ...counts, input_tokens: 2100 },
      turn_token_usage: usage,
    },
  }
}
function write(...rows: unknown[]) {
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zero-codex-rollout-usage-'))
  path = join(dir, 'rollout.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('returns the latest running total for the matching Codex thread and turn', async () => {
  write(
    record({ ...counts, input_tokens: 40 }),
    record(),
    record(counts, 'another-thread'),
    record(counts, thread, 'another-turn'),
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: counts } } },
    { type: 'response_item', payload: { text: JSON.stringify(record()) } },
  )
  expect(await readCodexTurnUsage(path, thread, turn)).toEqual(expected)
})

test('uses the protocol default for missing cache writes and rejects corrupt latest counts', async () => {
  write(record({ ...counts, cache_write_input_tokens: undefined }))
  expect(await readCodexTurnUsage(path, thread, turn)).toEqual({
    ...expected,
    cacheWriteInputTokens: 0,
  })
  for (const invalid of [
    null,
    {},
    { ...counts, input_tokens: -1 },
    { ...counts, total_tokens: 0.5 },
  ]) {
    write(record(), record(invalid))
    expect(await readCodexTurnUsage(path, thread, turn)).toBeUndefined()
  }
})

test('does not use history before the target turn began or a partial trailing record', async () => {
  write(record(), { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } })
  expect(await readCodexTurnUsage(path, thread, turn)).toBeUndefined()
  writeFileSync(path, `${JSON.stringify(record())}\n{"type":"tok`)
  expect(await readCodexTurnUsage(path, thread, turn)).toBeUndefined()
})

test('reads across blocks and stops when the evidence is outside the bounded tail', async () => {
  // Place part of the matching record on each side of a read boundary.
  writeFileSync(
    path,
    `${JSON.stringify(record())}\n${JSON.stringify('x'.repeat(32 * 1024 - 80))}\n`,
  )
  expect(await readCodexTurnUsage(path, thread, turn)).toEqual(expected)
  write(record(), { type: 'response_item', payload: 'x'.repeat(3 * 1024 * 1024) })
  expect(await readCodexTurnUsage(path, thread, turn)).toBeUndefined()
})

test('missing evidence, malformed rows and indirect paths stay unknown', async () => {
  expect(await readCodexTurnUsage(path, thread, turn)).toBeUndefined()
  expect(await readCodexTurnUsage(dir, thread, turn)).toBeUndefined()
  writeFileSync(path, '{"type":"token_usage_record",bad}\n')
  expect(await readCodexTurnUsage(path, thread, turn)).toBeUndefined()
  write(record())
  const link = join(dir, 'link')
  symlinkSync(path, link)
  expect(await readCodexTurnUsage(link, thread, turn)).toBeUndefined()
})
