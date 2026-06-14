import { estimateTokens } from '@zero-os/shared'
import type { ToolEvidence } from '@zero-os/shared'
import { CONTEXT_PARAMS } from './params'
import { persistToolResultEvidence } from './tool-evidence'

const TOOL_OUTPUT_LIMITS: Record<string, number> = {
  read: CONTEXT_PARAMS.toolOutput.read,
  write: CONTEXT_PARAMS.toolOutput.write,
  edit: CONTEXT_PARAMS.toolOutput.edit,
  bash: CONTEXT_PARAMS.toolOutput.bash,
  fetch: CONTEXT_PARAMS.toolOutput.fetch,
}

function toolOutputLimit(toolName: string): number {
  return TOOL_OUTPUT_LIMITS[toolName.toLowerCase()] ?? CONTEXT_PARAMS.toolOutput.default
}

export type ToolEvidenceReason = 'per_tool_prompt_budget' | 'oversized_artifact'

export interface ToolOutputArtifactization {
  content: string
  artifactPath?: string
  evidence?: ToolEvidence
  evidenceReason?: ToolEvidenceReason
  originalChars?: number
  originalTokens?: number
  promptTokenLimit?: number
  thresholdChars?: number
}

/**
 * Truncate tool output to fit within the tool's token budget.
 * Uses head 60% + tail 20% strategy with an omission marker in the middle.
 */
export function truncateToolOutput(toolName: string, output: string): string {
  const limit = toolOutputLimit(toolName)
  const tokens = estimateTokens(output)
  if (tokens <= limit) return output

  const lines = output.split('\n')
  const headCount = Math.ceil(lines.length * 0.6)
  const tailCount = Math.ceil(lines.length * 0.2)
  const head = lines.slice(0, headCount).join('\n')
  const tail = lines.slice(-tailCount).join('\n')

  return [
    head,
    '',
    `... (输出已截断: 原始 ${tokens} tokens, 保留头尾约 ${limit} tokens)`,
    '... (该内容作为 tool_result 写入会话消息，并会记录到后续请求对应的 llm_request trace span)',
    '',
    tail,
  ].join('\n')
}

/**
 * For medium output that exceeds the per-tool prompt budget, save raw output
 * before any later replay compaction while keeping the active turn high fidelity.
 * For oversized output (>64KB chars), return a compact reference.
 */
export function artifactizeToolOutput(
  toolName: string,
  output: string,
  opts: { workDir: string; sessionId?: string; toolUseId?: string; outputSummary?: string },
): ToolOutputArtifactization {
  const threshold = CONTEXT_PARAMS.toolOutput.artifactThresholdChars
  const toolUseId = opts.toolUseId ?? 'unknown_tool_use'
  const tokenCount = estimateTokens(output)
  const promptTokenLimit = toolOutputLimit(toolName)
  const exceedsPromptBudget = tokenCount > promptTokenLimit

  if (output.length <= threshold) {
    if (!exceedsPromptBudget) {
      return { content: output }
    }

    const evidence = persistToolResultEvidence({
      workDir: opts.workDir,
      sessionId: opts.sessionId ?? 'session',
      toolUseId,
      toolName,
      content: output,
      outputSummary: opts.outputSummary,
    })

    return {
      content: output,
      evidence,
      evidenceReason: 'per_tool_prompt_budget',
      originalChars: output.length,
      originalTokens: tokenCount,
      promptTokenLimit,
      thresholdChars: threshold,
    }
  }

  const evidence = persistToolResultEvidence({
    workDir: opts.workDir,
    sessionId: opts.sessionId ?? 'session',
    toolUseId,
    toolName,
    content: output,
    outputSummary: opts.outputSummary,
  })
  const artifactPath = evidence.path

  const summary = output.slice(0, 500)
  const tail = output.slice(-200)
  const content = [
    `[Artifact: 原始输出 ${output.length.toLocaleString()} 字符，已落盘]`,
    `路径: ${artifactPath}`,
    '',
    '--- 摘要 ---',
    summary,
    '',
    '--- 尾部 ---',
    tail,
    '',
    `[使用 read 工具查看完整内容: ${artifactPath}]`,
  ].join('\n')

  return {
    content,
    artifactPath,
    evidence,
    evidenceReason: 'oversized_artifact',
    originalChars: output.length,
    originalTokens: tokenCount,
    promptTokenLimit,
    thresholdChars: threshold,
  }
}
