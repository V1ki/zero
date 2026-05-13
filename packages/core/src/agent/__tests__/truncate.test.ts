import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactizeToolOutput, truncateToolOutput } from '../truncate'

describe('truncateToolOutput', () => {
  test('returns original output when within limit for read tool', () => {
    const output = 'Hello world\nThis is a small file.'
    const result = truncateToolOutput('read', output)
    expect(result).toBe(output)
  })

  test('returns original output for short write tool output', () => {
    const output = 'File written successfully.'
    const result = truncateToolOutput('write', output)
    expect(result).toBe(output)
  })

  test('truncates long bash output exceeding 4000 tokens', () => {
    const output = 'x\n'.repeat(20000)
    const result = truncateToolOutput('bash', output)
    expect(result.length).toBeLessThan(output.length)
  })

  test('truncated output contains omission marker with Chinese text', () => {
    const output = 'x\n'.repeat(20000)
    const result = truncateToolOutput('bash', output)
    expect(result).toContain('输出已截断')
    expect(result).toContain('会记录到后续请求对应的 llm_request trace span')
  })

  test('truncated output contains head and tail sections', () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `line-${i}`)
    const output = lines.join('\n')
    const result = truncateToolOutput('bash', output)

    // Head: first 60% of lines should be present
    expect(result).toContain('line-0')
    expect(result).toContain('line-1')

    // Tail: last 20% of lines should be present
    expect(result).toContain(`line-${20000 - 1}`)
    expect(result).toContain(`line-${20000 - 2}`)
  })

  test('uses default 4000 limit for unknown tool names', () => {
    // Generate output that exceeds 4000 tokens but is under 8000 (read limit)
    // estimateTokens uses Math.ceil(text.length / 3.5)
    // 4000 tokens * 3.5 = 14000 chars. Generate ~18000 chars to exceed 4000 tokens.
    const output = 'ab\n'.repeat(6000) // 6000 * 3 = 18000 chars => ~5143 tokens
    const resultUnknown = truncateToolOutput('unknown_tool', output)
    expect(resultUnknown).toContain('输出已截断')

    // Same output should NOT be truncated for 'read' (limit 8000)
    const resultRead = truncateToolOutput('read', output)
    expect(resultRead).toBe(output)
  })

  test('case-insensitive tool name matching', () => {
    const smallOutput = 'Hello world'

    // Both 'Read' and 'read' should use the same limit (8000)
    const resultUpper = truncateToolOutput('Read', smallOutput)
    const resultLower = truncateToolOutput('read', smallOutput)
    expect(resultUpper).toBe(resultLower)
    expect(resultUpper).toBe(smallOutput)

    // Verify with a large output that 'BASH' and 'bash' behave the same
    const largeOutput = 'x\n'.repeat(20000)
    const resultBashUpper = truncateToolOutput('BASH', largeOutput)
    const resultBashLower = truncateToolOutput('bash', largeOutput)
    expect(resultBashUpper).toBe(resultBashLower)
    expect(resultBashUpper).toContain('输出已截断')
  })
})

describe('artifactizeToolOutput', () => {
  test('keeps short inline output unchanged when output is within prompt budget', () => {
    const output = 'Hello world\nThis stays inline.'
    const result = artifactizeToolOutput('read', output, { workDir: process.cwd() })

    expect(result).toEqual({
      content: output,
    })
  })

  test('stores raw evidence for medium outputs that exceed tool budget without truncating active turn content', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-medium-evidence-'))

    try {
      const output = 'medium-line\n'.repeat(2000)
      expect(output.length).toBeLessThan(65536)
      expect(truncateToolOutput('write', output)).not.toBe(output)

      const result = artifactizeToolOutput('write', output, {
        workDir,
        sessionId: 'sess_medium_budget',
        toolUseId: 'tool-medium',
      })

      expect(result.artifactPath).toBeUndefined()
      expect(result.content).toBe(output)
      expect(result.evidenceReason).toBe('per_tool_prompt_budget')
      expect(result.originalChars).toBe(output.length)
      expect(result.evidence).toBeDefined()
      expect(result.evidence?.path).toContain('.artifacts/sess_medium_budget/tool-evidence')
      expect(result.evidence?.chars).toBe(output.length)
      expect(result.evidence?.kind).toBe('tool_result_output')
      expect(result.evidence?.toolUseId).toBe('tool-medium')
      expect(result.evidence?.writeStatus).toBe('created')
      expect(readFileSync(result.evidence?.path ?? '', 'utf-8')).toBe(output)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('writes oversized output to artifact file and returns compact reference', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'zero-artifactize-'))

    try {
      const output = `${'A'.repeat(70000)}\n${'B'.repeat(300)}`
      const result = artifactizeToolOutput('bash', output, {
        workDir,
        sessionId: 'sess_artifact_test',
        toolUseId: 'tool-1',
      })

      expect(result.artifactPath).toBeDefined()
      expect(result.evidence).toBeDefined()
      expect(result.evidenceReason).toBe('oversized_artifact')
      expect(result.evidence?.kind).toBe('tool_result_output')
      expect(result.evidence?.toolUseId).toBe('tool-1')
      expect(result.evidence?.writeStatus).toBe('created')
      expect(result.content).toContain('[Artifact: 原始输出')
      expect(result.content).toContain('--- 摘要 ---')
      expect(result.content).toContain('--- 尾部 ---')
      expect(result.content).toContain('[使用 read 工具查看完整内容:')

      const artifactPath = result.artifactPath
      expect(artifactPath).toBeDefined()
      if (!artifactPath) throw new Error('Expected artifact path')
      expect(existsSync(artifactPath)).toBe(true)
      expect(artifactPath.startsWith(join(workDir, '.artifacts', 'sess_artifact_test'))).toBe(true)
      expect(readFileSync(artifactPath, 'utf-8')).toBe(output)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})
