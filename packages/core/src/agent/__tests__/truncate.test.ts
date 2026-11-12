import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactizeToolOutput } from '../truncate'

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

describe('tool evidence storage', () => {
  test('keeps artifact evidence root out of tracked source by gitignore policy', () => {
    const gitignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf-8')

    expect(gitignore.split(/\r?\n/)).toContain('.artifacts/')
  })
})
