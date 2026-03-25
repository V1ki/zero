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

export const TASK_CLOSURE_PROMPT = `<system_notice>
你刚才已经给出了一个阶段性结果，但把当前任务的必要后续动作写成了可选下一步。
如果这些动作仍属于回答当前问题的必要组成部分，请直接继续执行，不要把它们交还给用户选择。
只有在你确实缺少用户提供的信息、授权、凭据、登录态，或下一步涉及不可逆外部操作时，才说明真实阻塞并停止。
不要用“如果你愿意”“如果你要”“要不要我继续”“我下一步可以”或类似可选分支菜单收尾。
当前进度可参考上方的工具调用历史。
</system_notice>`

export const TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT =
  '你是一个严格的任务收尾判定器。你只输出合法 JSON，不要输出解释、代码块或额外文本。'

export function buildTaskClosureDecisionPrompt(
  userMessage: string,
  assistantText: string,
  assistantTail: string,
  context?: TaskClosurePromptContext,
): string {
  return `<instruction>
你是一个任务收尾判定器。请判断 assistant 的收尾是否把当前任务的必要后续动作包装成了可选下一步。

判定原则：
- 如果 assistant 已经完整回答用户问题，返回 finish。
- 如果 assistant 只是把完成当前问题所必需的低成本后续动作写成了“如果你愿意，我可以继续……”，返回 continue。
- 如果 assistant 明确缺少用户提供的信息、授权、凭据、登录态，或下一步涉及不可逆外部动作，返回 block。
- 如果 assistant 声称已完成某操作，且 <tool_calls_this_turn> 中有对应的成功工具调用记录，该操作视为已实际执行，不属于虚假确认，应返回 finish 而非 block。
- 只有当用户明确要求”给我下一步选项 / 后续选项 / 还能做什么”时，菜单式收尾才算 finish。

研究/分析类任务额外规则：
- 如果用户要求分析、深入分析、研究、核验，或要求把“相关信息 / 相关线索”也一起分析，不能因为 assistant 已经给出一版总结就直接返回 finish。
- 对研究/分析类任务，只有当 assistant 已覆盖原始材料的关键主张、扩展到主要相关信息、尽可能做了多源交叉验证，并明确区分已证实与未证实部分时，才可返回 finish。
- 如果 assistant 当前更像第一轮读后总结、只分析了单一来源、或仍明确指出还有重要相关线索/来源值得继续查证，则返回 continue。
- 如果继续查证、补充相关信息、拆分关键主张，会实质提升回答质量而不是只做边际润色，则返回 continue。

特别示例：
- 用户让你“看看某个帖子/链接，并把可能相关的信息也分析下”，而 assistant 只总结了当前内容或一两个来源，然后说“如果你愿意我还可以继续查更多相关信息/来源”，这通常应判为 continue，不是 finish。

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

<assistant_text>
${assistantText}
</assistant_text>

<assistant_tail>
${assistantTail}
</assistant_tail>`
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

  switch (toolName.toLowerCase()) {
    case 'fetch': {
      return `${extractFetchDomain(input) ?? 'request'} ${status}`
    }
    case 'bash': {
      return `${getTrimmedString(input.description) ?? sanitizeBashSummary(result?.outputSummary) ?? 'command'} ${status}`
    }
    case 'read':
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
