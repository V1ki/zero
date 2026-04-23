import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { estimateTokens } from '@zero-os/shared'
import { CONTEXT_PARAMS } from './params'

const TOOL_OUTPUT_LIMITS: Record<string, number> = {
  read: CONTEXT_PARAMS.toolOutput.read,
  write: CONTEXT_PARAMS.toolOutput.write,
  edit: CONTEXT_PARAMS.toolOutput.edit,
  bash: CONTEXT_PARAMS.toolOutput.bash,
  fetch: CONTEXT_PARAMS.toolOutput.fetch,
}

/**
 * Truncate tool output to fit within the tool's token budget.
 * Uses head 60% + tail 20% strategy with an omission marker in the middle.
 */
export function truncateToolOutput(toolName: string, output: string): string {
  const limit = TOOL_OUTPUT_LIMITS[toolName.toLowerCase()] ?? CONTEXT_PARAMS.toolOutput.default
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
 * For oversized tool output (>64KB chars), save raw output to disk as an artifact
 * and return a compact reference for the conversation context.
 * For normal-sized output, delegates to truncateToolOutput.
 */
export function artifactizeToolOutput(
  toolName: string,
  output: string,
  opts: { workDir: string; toolUseId?: string },
): { content: string; artifactPath?: string } {
  const threshold = CONTEXT_PARAMS.toolOutput.artifactThresholdChars
  if (output.length <= threshold) {
    return { content: truncateToolOutput(toolName, output) }
  }

  const artifactDir = join(opts.workDir, '.artifacts')
  mkdirSync(artifactDir, { recursive: true })
  const filename = `tool-output-${Date.now()}-${toolName}.txt`
  const artifactPath = join(artifactDir, filename)
  writeFileSync(artifactPath, output, 'utf-8')

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

  return { content, artifactPath }
}
