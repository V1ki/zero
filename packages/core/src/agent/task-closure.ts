import { basename } from 'node:path'
import type { ContentBlock, Message } from '@zero-os/shared'

export type TaskClosureAction = 'finish' | 'continue' | 'block'

export interface TaskClosureDecision {
  action: TaskClosureAction
  reason: string
}

export interface TaskClosurePromptContext {
  toolSummary: string
}

export function buildTaskClosurePrompt(reason: string): string {
  return `<system_notice>
你刚才已经给出了一个阶段性结果，但把当前任务的必要后续动作写成了可选下一步。
如果这些动作仍属于回答当前问题的必要组成部分，请直接继续执行，不要把它们交还给用户选择。
已有授权持续有效；只有下一动作超出授权范围，或确实缺少必要信息、凭据、登录态或决策时，才说明真实阻塞并停止。
分析请求保持分析范围，不自动实施建议；若当前要求已经满足，正常交付，不为扩展话题继续执行。
不要把当前任务的必要动作留作“如果你愿意”等可选服务。
当前进度可参考上方的工具调用历史。
<classifier_reason>${reason}</classifier_reason>
</system_notice>`
}

export const TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT =
  '你是一个严格的任务收尾判定器。你只输出合法 JSON，不要输出解释、代码块或额外文本。'

export function buildTaskClosureDecisionPrompt(
  userMessage: string,
  assistantText: string,
  context?: TaskClosurePromptContext,
  appliedQueuedIntentText?: string,
): string {
  return `<instruction>
你是一个任务收尾判定器。请判断 assistant 的收尾是否把当前任务的必要后续动作包装成了可选下一步。

判定原则：
- 如果 assistant 已经完整回答用户问题，返回 finish。
- 如果 assistant 只是把完成当前问题所必需的低成本后续动作写成了“如果你愿意，我可以继续……”，返回 continue。
- 如果下一动作超出授权范围，或确实缺少必要信息、凭据、登录态或决策，返回 block。已有授权持续有效，不因操作属于外部写入、配置修改或不可逆动作而重复要求确认。
- 成功工具记录可以证明对应操作已经执行，但仍须检查当前任务的其他要求；不能仅因一个操作成功就判定整体完成。
- 按剩余必要工作判定，不按结尾措辞判定；当前要求已满足时返回 finish，额外建议不构成继续执行的理由。用户要求分析或列出选项，不等于授权实施建议。

研究/分析类任务额外规则：
- 以用户要求的范围和深度为准。普通解释、摘要或局部分析，已有材料足以支持结论且已区分证据与推断时，返回 finish；不因只使用单一来源或首次总结就要求继续。
- 用户明确要求深入研究、多源交叉验证或相关线索分析时，检查这些要求是否完成。
- 只有仍缺少完成当前要求所必需、会影响结论且可以继续取得的证据时，返回 continue；必要证据无法自行取得时说明真实阻塞。不要仅因更多研究可能有益就继续。

后台任务额外规则：
- 如果 <tool_calls_this_turn>、<user_message> 或 <assistant_text> 显示已有 background_tool.started / Background task started，且尚未看到对应的 background_tool.completed，而 assistant 当前是在说明后台任务仍在运行、会等待系统完成事件或完成后再继续，则返回 finish。这里的 finish 表示不要注入前台 task_closure continuation，把“等待已知后台完成事件”视为合法暂停态，不代表整个用户任务已经最终完成。
- 不要把系统管理的后台任务等待判为 continue；continue 会把 agent 拉回前台，容易造成 sleep/ps/pgrep/lsof/wc/tail/ls/find/stat 之类人工轮询。
- 不要把“等待 background_tool.completed”判为 block；等待已知后台事件不需要用户介入。
- 如果 assistant 声称后台任务产物已经完成、已验证或已发布，但没有 background_tool.completed 或其他成功工具记录支撑，则返回 block。
- 如果 <user_message> 是 background_tool.completed，则根据其中的 status、output_summary、output 和后续工具记录判断；status=error 不一定代表任务失败，仍需看是否有可用产物和后续验收。

返回 JSON，不要其他内容：
{"action":"finish|continue|block","reason":"简短原因"}

要求：
- 不要重写 assistant 内容，只做判定。
</instruction>

<tool_calls_this_turn>
${context?.toolSummary || 'none'}
</tool_calls_this_turn>

<user_message>
${userMessage}
</user_message>

${
  appliedQueuedIntentText
    ? `
<applied_queued_messages>
以下是本轮中用户追加发来的消息（已纳入执行）：
${appliedQueuedIntentText}
</applied_queued_messages>`
    : ''
}

<assistant_text>
${assistantText}
</assistant_text>`
}

interface ToolResultSummary {
  isError?: boolean
  outputSummary?: string
}

export function buildTaskClosurePromptContext(messages: Message[]): TaskClosurePromptContext {
  const toolResults = new Map<string, ToolResultSummary>()
  const toolGroups = new Map<string, string[]>()

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        toolResults.set(block.toolUseId, {
          isError: block.isError,
          outputSummary: block.outputSummary,
        })
      }
    }
  }

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue

      const toolName = block.name.toLowerCase()
      const detail = extractToolDetail(toolName, block.input, toolResults.get(block.id))
      const existing = toolGroups.get(toolName)
      if (existing) {
        existing.push(detail)
      } else {
        toolGroups.set(toolName, [detail])
      }
    }
  }

  const lines = Array.from(toolGroups.entries())
    .map(([toolName, details]) => formatToolGroup(toolName, details))
    .filter((line) => line.length > 0)

  return {
    toolSummary: lines.length > 0 ? lines.join('; ') : 'none',
  }
}

export function extractToolDetail(
  toolName: string,
  input: Record<string, unknown>,
  result?: ToolResultSummary,
): string {
  const status = formatToolStatus(result)
  const backgroundSummary = extractBackgroundToolSummary(result?.outputSummary)
  if (backgroundSummary) return `${backgroundSummary} ${status}`

  switch (toolName.toLowerCase()) {
    case 'fetch': {
      return `${extractFetchDomain(input) ?? 'request'} ${status}`
    }
    case 'bash': {
      return `${getTrimmedString(input.description) ?? sanitizeBashSummary(result?.outputSummary) ?? 'command'} ${status}`
    }
    case 'read':
    case 'read_image':
    case 'write':
    case 'edit': {
      return `${extractFileName(input) ?? 'unknown file'} ${status}`
    }
    default: {
      const action = getTrimmedString(input.action)
      return action ? `${action} ${status}` : status
    }
  }
}

export function formatToolGroup(toolName: string, details: string[]): string {
  if (details.length === 0) return ''

  const normalizedName = toolName.toLowerCase()

  switch (normalizedName) {
    case 'fetch': {
      const summary = details.slice(0, 2).join(', ')
      return details.length > 1 ? `fetch ${summary} 共 ${details.length} 次` : `fetch ${summary}`
    }
    case 'bash':
      return `bash 执行 ${details.slice(0, 4).join(', ')}`
    case 'read':
    case 'read_image':
    case 'write':
    case 'edit': {
      if (details.length === 1) return `${normalizedName} ${details[0]}`

      const summary = details.slice(0, 4).join(', ')
      const suffix = details.length > 4 ? ' 等' : ''
      return `${normalizedName} ${details.length} 个文件: ${summary}${suffix}`
    }
    default:
      return `${normalizedName} ${details.length}次: ${details.slice(0, 4).join(', ')}`
  }
}

export function parseTaskClosureDecision(response: string): TaskClosureDecision | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    const action = parsed.action
    const reason = parsed.reason

    if (action !== 'finish' && action !== 'continue' && action !== 'block') return null
    if (typeof reason !== 'string') return null

    return {
      action,
      reason,
    }
  } catch {
    return null
  }
}

export { extractAssistantText } from '@zero-os/shared'

export function extractAssistantTail(content: ContentBlock[], maxChars = 1200): string {
  const lastText = getLastTextBlockText(content)
  if (!lastText) return ''
  return lastText.length <= maxChars ? lastText : lastText.slice(-maxChars)
}

export function hasAssistantText(content: ContentBlock[]): boolean {
  return content.some((block) => block.type === 'text' && block.text.trim().length > 0)
}

function getLastTextBlockText(content: ContentBlock[]): string {
  for (let index = content.length - 1; index >= 0; index--) {
    const block = content[index]
    if (block?.type === 'text') return block.text
  }
  return ''
}

function formatToolStatus(result?: ToolResultSummary): string {
  if (!result) return '…'
  return result.isError ? '✗' : '✓'
}

function extractFetchDomain(input: Record<string, unknown>): string | undefined {
  const url = getTrimmedString(input.url)
  if (!url) return undefined

  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function extractFileName(input: Record<string, unknown>): string | undefined {
  const path = getTrimmedString(input.path)
  return path ? basename(path) : undefined
}

function getTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function sanitizeBashSummary(summary: string | undefined): string | undefined {
  const trimmed = getTrimmedString(summary)
  if (!trimmed) return undefined

  const sanitized = trimmed.replace(/^(?:Executed|Command failed(?:\s*\([^)]*\))?):\s*/, '')
  return sanitized || trimmed
}

function extractBackgroundToolSummary(summary: string | undefined): string | undefined {
  const trimmed = getTrimmedString(summary)
  if (!trimmed) return undefined

  if (/^Background task started:/i.test(trimmed)) return trimmed
  if (trimmed.includes('background_tool.started')) return trimmed
  if (trimmed.includes('background_tool.completed')) return trimmed

  return undefined
}
