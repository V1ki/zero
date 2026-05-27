import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@zero-os/shared'
import {
  CONTEXT_COMPACTION_PROMPT_VERSION,
  buildContextCompactionPrompt,
  isContextCompactionModelOutputUsable,
  parseContextCompactionModelOutput,
} from '../compress'
import type { ContextCompactionModelInput } from '../context'

function makeInput(): ContextCompactionModelInput {
  const messages: Message[] = [
    {
      id: 'msg_user_1',
      sessionId: 'sess_compact_model',
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text: '检查 context compaction 为什么重复触发' }],
      createdAt: '2026-05-16T10:00:00.000Z',
    },
    {
      id: 'msg_assistant_tool_1',
      sessionId: 'sess_compact_model',
      role: 'assistant',
      messageType: 'message',
      content: [
        { type: 'text', text: '读取上下文实现。' },
        {
          type: 'tool_use',
          id: 'tool_read_context',
          name: 'read',
          input: { path: '/repo/packages/core/src/agent/context.ts', offset: 380, limit: 120 },
        },
      ],
      createdAt: '2026-05-16T10:00:01.000Z',
    },
    {
      id: 'msg_tool_result_1',
      sessionId: 'sess_compact_model',
      role: 'user',
      messageType: 'message',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'tool_read_context',
          content: 'planEpisodeCompaction skips already covered messages and compacts new tails.',
          outputSummary: 'Read context compaction planning code.',
        },
      ],
      createdAt: '2026-05-16T10:00:02.000Z',
    },
  ]

  return {
    sessionId: 'sess_compact_model',
    blockId: 'timeline_compaction_test',
    strategyVersion: 'timeline_compaction_block_v3',
    currentGoal: '重构 context compaction',
    segment: messages,
    retainedMessages: [],
    workingStateSummary: '<working_state_compaction>continue</working_state_compaction>',
    episode: {
      id: 'episode_test',
      sessionId: 'sess_compact_model',
      status: 'confirmed',
      boundaryStrategy: 'deterministic_contiguous_older_turns_v1',
      boundaryReason: 'fixture',
      goal: '检查 context compaction 为什么重复触发',
      scope: ['/repo/packages/core/src/agent/context.ts'],
      toolUseIds: ['tool_read_context'],
      confirmedFacts: ['read tool returned code context'],
      inferredFacts: [],
      blockers: [],
      needsRawReview: [],
      evidence: [],
      summary: 'fixture episode',
      messageIds: messages.map((message) => message.id),
    },
  }
}

describe('context compaction model prompt and parser', () => {
  test('builds Chinese XML prompt with message and tool references', () => {
    const prompt = buildContextCompactionPrompt(makeInput())

    expect(prompt).toContain(CONTEXT_COMPACTION_PROMPT_VERSION)
    expect(prompt).toContain('请分析并压缩')
    expect(prompt).toContain('<message_index>')
    expect(prompt).toContain('E1 id=msg_user_1')
    expect(prompt).toContain('<tool_index>')
    expect(prompt).toContain('K1 tool=read use_id=tool_read_context')
  })

  test('includes raw tool_result content in the compaction model prompt', () => {
    const input = makeInput()
    const result = input.segment[2]?.content[0]
    if (result?.type !== 'tool_result') throw new Error('fixture expected tool result')
    result.outputSummary = 'Short summary should not replace raw compact input.'
    result.content = `RAW_TOOL_OUTPUT_${'large output '.repeat(200)}`

    const prompt = buildContextCompactionPrompt(input)

    expect(prompt).toContain('<tool_result_raw><![CDATA[')
    expect(prompt).toContain('RAW_TOOL_OUTPUT_')
    expect(prompt).toContain('output_summary=Short summary should not replace raw compact input.')
  })

  test('reads raw tool_result from evidence file when message content is artifactized', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-compaction-evidence-'))
    try {
      const evidencePath = join(workDir, 'tool-result.txt')
      const raw = 'FULL_EVIDENCE_TOOL_RESULT path=/repo/final.md media_id=abc123'
      writeFileSync(evidencePath, raw, 'utf-8')
      const input = makeInput()
      const result = input.segment[2]?.content[0]
      if (result?.type !== 'tool_result') throw new Error('fixture expected tool result')
      result.content = '[Artifact: 原始输出已落盘]'
      result.evidence = {
        kind: 'tool_result_output',
        sessionId: 'sess_compact_model',
        toolUseId: 'tool_read_context',
        toolName: 'read',
        path: evidencePath,
        chars: raw.length,
        bytes: Buffer.byteLength(raw, 'utf-8'),
        sha256: 'abc123def456',
        createdAt: '2026-05-16T10:00:02.000Z',
      }

      const prompt = buildContextCompactionPrompt(input)

      expect(prompt).toContain('FULL_EVIDENCE_TOOL_RESULT')
      expect(prompt).toContain('media_id=abc123')
      expect(prompt).toContain(`evidence_path=${evidencePath}`)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('parses valid XML into topics and validates tool coverage', () => {
    const input = makeInput()
    const output = parseContextCompactionModelOutput(
      `<context_compaction prompt_version="${CONTEXT_COMPACTION_PROMPT_VERSION}">
  <block_summary>旧的 compaction 行为已经定位到 context planning。</block_summary>
  <topics>
    <topic id="T1" status="in_progress" message_refs="E1,E2,E3" tool_refs="K1" needs_raw_review="false">
      <title>重复压缩触发分析</title>
      <summary>用户要求检查重复压缩，assistant 读取 context.ts 并确认当前逻辑会跳过已覆盖消息但仍可能压缩新的 tail。</summary>
      <confirmed_facts><item>K1 返回了 context planning 代码摘要。</item></confirmed_facts>
      <current_state><item>下一步应改 block 复用和 recompact。</item></current_state>
      <evidence><item>K1 result Read context compaction planning code.</item></evidence>
    </topic>
  </topics>
  <user_constraints><item>不要丢失 tool IO 证据。</item></user_constraints>
  <do_not_infer><item>不能把读取代码视为线上行为验证。</item></do_not_infer>
</context_compaction>`,
      input,
    )

    expect(isContextCompactionModelOutputUsable(output)).toBe(true)
    expect(output?.validation?.status).toBe('passed')
    expect(output?.topics?.[0]?.sourceMessageIds).toEqual([
      'msg_user_1',
      'msg_assistant_tool_1',
      'msg_tool_result_1',
    ])
    expect(output?.topics?.[0]?.toolUseIds).toEqual(['tool_read_context'])
  })

  test('marks malformed tool references as unusable instead of accepting them', () => {
    const output = parseContextCompactionModelOutput(
      `<context_compaction>
  <block_summary>bad refs</block_summary>
  <topics>
    <topic id="T1" status="completed" message_refs="E1" tool_refs="E1">
      <title>bad</title>
      <summary>bad</summary>
    </topic>
  </topics>
</context_compaction>`,
      makeInput(),
    )

    expect(output?.validation?.status).toBe('failed')
    expect(output?.validation?.errors).toContain('topic_T1_has_message_ref_in_tool_refs')
    expect(isContextCompactionModelOutputUsable(output)).toBe(false)
  })
})
