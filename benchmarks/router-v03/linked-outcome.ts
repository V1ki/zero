import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RouterLedgerStore } from '@zero-os/observe'
import type {
  RouterAgentInput,
  createRouterAgent,
} from '../../apps/server/src/triggers/router-agent'

/** Rerun an actual consultation with its recorded matter and current Router. Only its read is enabled. */
export async function verifyLinkedOutcome(
  output: string,
  ask: ReturnType<typeof createRouterAgent>,
  base: RouterAgentInput,
  ledger: RouterLedgerStore,
) {
  const source = process.env.ZERO_ACCEPTANCE_TRACE_DB
  const id = process.env.ZERO_ACCEPTANCE_SOURCE_RUN
  assert(source && id, 'Provide a trace database and the original consultation run ID')
  const db = new Database(source, { readonly: true })
  let prompt: { question: string; matters: unknown }
  let receipt: { result: { output: string } }
  try {
    const original = db
      .query<{ data: string }, [string]>(
        "SELECT data FROM router_trace_entries WHERE run_id=? AND kind='input'",
      )
      .get(id)
    const read = db
      .query<{ data: string }, [string]>(
        "SELECT data FROM router_trace_entries WHERE run_id=? AND kind='tool_result' AND json_extract(data,'$.name')='read_matter'",
      )
      .get(id)
    assert(original && read)
    prompt = JSON.parse(JSON.parse(original.data).prompt)
    receipt = JSON.parse(read.data)
  } finally {
    db.close()
  }
  const readMatter = JSON.parse(receipt.result.output)
  const answer = await ask({
    ...base,
    sessionId: 'linked-outcome',
    imPlatform: 'weixin',
    question: prompt.question,
    matterContext: prompt.matters,
    actions: {
      capabilities: [
        {
          definition: {
            name: 'read_matter',
            description: '读取当前事项、原始目标、完成条件及已有证据。',
            parameters: {
              type: 'object',
              properties: { matterId: { type: 'string' } },
              required: ['matterId'],
            },
          },
          execute(args) {
            assert.equal(args.matterId, readMatter.id)
            return readMatter
          },
        },
      ],
    },
  })
  const run = ledger.listRuns({ sessionId: 'linked-outcome' })[0]
  writeFileSync(
    join(output, 'linked-outcome.json'),
    JSON.stringify(
      { sourceRun: id, run: run.id, question: prompt.question, answer: answer.text },
      null,
      2,
    ),
  )
  assert(answer.text.includes('186') && /验证|复测|复现|回归/.test(answer.text))
  assert(/评论|讨论|回复|反馈|回帖|补充.{0,15}(证据|验证|结果)/.test(answer.text))
  assert(/关闭|结案/.test(answer.text) && /继续|保留|重新打开|重开|未解决/.test(answer.text))
}
