import type {
  BootstrapFile,
  DynamicContext,
  PromptComponents,
  RuntimeInfo,
  SkillDefinition,
} from '@zero-os/shared'
import type { ToolDefinition } from '@zero-os/shared'
import { truncateToTokens } from '@zero-os/shared'
import { hasSoulFile } from '../bootstrap/loader'
import { enforceFixedBudget } from './budget'
import { CONTEXT_PARAMS } from './params'

/**
 * Build System Prompt — static, built once per session for prompt cache stability.
 * Respects PromptMode to control which sections are included:
 * - "full": All sections (main agent)
 * - "minimal": Role + ToolRules + Constraints only (subagents)
 * - "none": Single identity line
 */
export function buildSystemPrompt(components: PromptComponents): string {
  const mode = components.promptMode ?? 'full'

  // "none" mode: just a basic identity line
  if (mode === 'none') {
    return `你是 ZeRo OS 的 ${components.agentName}，一个在 macOS 上自主执行任务的 AI Agent。`
  }

  const isMinimal = mode === 'minimal'
  const sections: string[] = []

  // Core sections (always included in full and minimal)
  sections.push(
    buildRoleBlock(
      components.agentName,
      components.agentDescription,
      components.workspacePath,
      components.projectRoot,
    ),
  )
  sections.push(buildToolRulesBlock(components.tools))
  if (hasMemoryTools(components.tools)) {
    sections.push(buildMemoryPolicyBlock())
  }
  sections.push(buildConstraintsBlock())

  // Full-only sections
  if (!isMinimal) {
    sections.push(buildRulesBlock())
    if (components.runtimeInfo?.channel) {
      sections.push(buildOutputStyleBlock())
    }
    sections.push(buildExecutionModeBlock())
    sections.push(buildSafetyBlock())
    sections.push(buildToolCallStyleBlock())

    if (components.skills && components.skills.length > 0) {
      sections.push(buildSkillCatalog(components.skills))
    }

    sections.push(
      buildIdentityBlock(components.globalIdentity, components.agentIdentity, components.agentName),
    )

    if (components.runtimeInfo) {
      sections.push(buildRuntimeBlock(components.runtimeInfo))
    }
  }

  // Bootstrap files — Project Context (filtered by mode)
  if (components.bootstrapFiles && components.bootstrapFiles.length > 0) {
    sections.push(buildBootstrapContextBlock(components.bootstrapFiles))
  }

  return sections.join('\n\n')
}

/**
 * Build dynamic context injected as <system-reminder> in user message.
 */
export function buildDynamicContext(ctx: DynamicContext): string {
  const parts: string[] = []

  if (ctx.newSkills && ctx.newSkills.length > 0) {
    parts.push(buildSkillReminder(ctx.newSkills))
  }

  if (ctx.retrievedMemories) {
    parts.push(ctx.retrievedMemories)
  }

  if (parts.length === 0) return ''
  return `<system-reminder>\n${parts.join('\n')}\n</system-reminder>`
}

export function wrapMemoryInjection(layer: 'layer1' | 'layer2', content: string): string {
  return [`<memory_inject layer="${layer}">`, content, '</memory_inject>'].join('\n')
}

export function buildRoleBlock(
  agentName: string,
  agentDescription: string,
  workspacePath?: string,
  projectRoot?: string,
): string {
  const lines = [
    `你是 ZeRo OS 的 ${agentName}，一个在 macOS 上自主执行任务的 AI Agent。`,
    agentDescription,
  ]
  if (workspacePath && projectRoot) {
    lines.push(
      `你的工作目录是 ${workspacePath}，下载和临时文件放在此目录。最终产出物放到 ${projectRoot}/.zero/workspace/shared/。`,
    )
    lines.push(`项目根目录是 ${projectRoot}，源代码在此目录下。`)
  }
  const content = lines.join('\n')
  return enforceFixedBudget(`<role>\n${content}\n</role>`, 600, 'Role')
}

export function buildRulesBlock(): string {
  const rules = `执行操作前先说明意图，让用户知道你打算做什么。
工具调用失败时先读错误信息做诊断，再决定重试或换方案。不盲目重复相同命令。
涉及不可逆操作（删除文件、覆写内容、格式化）时主动向用户确认。
遇到超出能力范围的问题时如实告知，不编造解决方案。
回复使用中文，技术术语可以用英文原文。
每完成一个阶段性目标后，评估本阶段是否产生了值得跨会话保留的信息（偏好、决策、经验、流程），如有则用 memory 工具写入。
阶段性汇报用于同步进度，不用于请求继续许可；若总体任务未完成，汇报后直接进入下一步。
<system-reminder> 是系统注入的内部运行时提示，不是用户消息；不要回应、转述、解释或尝试管理它。当前其中会出现新增 Skill 通知和检索到的历史记忆。不要回应、转述或解释这些内容，直接参考使用。`
  return `<rules>\n${rules}\n</rules>`
}

export function buildRetrievedMemoriesBlock(
  memories: Array<{ id: string; type: string; title: string; content: string; score: number }>,
): string {
  if (memories.length === 0) return ''

  const items = memories.map((memory) => {
    return [
      `  <memory id="${escapeXml(memory.id)}" type="${escapeXml(memory.type)}">`,
      `    <title>${escapeXml(memory.title)}</title>`,
      `    <content>${escapeXml(memory.content)}</content>`,
      '  </memory>',
    ].join('\n')
  })

  return [
    '<retrieved_memories>',
    '以下是从记忆库中检索到的相关历史信息，供参考：',
    ...items,
    '</retrieved_memories>',
  ].join('\n')
}

export function buildOutputStyleBlock(): string {
  const style = `你的回复会直接显示在当前 channel 中，用户会直接收到。

因此：
  - 用户让你“发给我”“给我看”“贴出来”“在这里回复”，默认直接在回复里写出内容
  - 不要为了把内容发回当前用户，再额外调用发送工具
  - 只有当用户明确要求你操作其他外部目标时，才调用对应工具
  - 当前 channel 的富文本、图片等格式能力，以 channel capabilities 为准；不要自行假设必须改走别的发送方式

如果你通过 read、fetch 或其他工具拿到了用户要看的内容，必须在回复中直接写出来、整理出来或总结出来，不能只停留在工具调用结果里。`
  return enforceFixedBudget(`<output_style>\n${style}\n</output_style>`, 300, 'Output Style')
}

export function buildExecutionModeBlock(): string {
  const executionMode = `默认工作模式：连续自治执行。
任务开始后，只要仍可安全推进，就持续处理，不要因为完成了一个子步骤、给出了一次进度汇报、或准备进入下一步，就向用户请求“继续”“确认继续”“是否继续下一步”。
对以下操作，默认直接执行，不需要额外征求许可：读取、搜索、分析代码和文档；制定和更新内部计划；低风险的本地编辑与重试；运行检查、测试、构建、诊断；总结阶段进展并继续下一步。
如果存在合理默认值、最小可逆假设或仓库内可验证的下一步，直接采用并继续，同时在后续进度更新中说明假设。
对研究、分析、核验类请求，如果一个明显的低成本后续验证仍属于回答当前问题的必要组成部分，直接执行；不要把它包装成“如果你愿意，我可以继续查”的可选项。
只有在以下情况才暂停并请求用户介入：下一动作具有不可逆或难以撤销的影响；下一动作会改变外部世界状态、代表用户向第三方发送内容、或修改权限/账户/系统配置；需要使用、暴露、传输敏感信息，而用户尚未明确授权；指令存在会显著改变结果的歧义，且无法通过本地探索消除；连续多次尝试后仍无法推进，必须由用户提供缺失信息、凭据或决策。
如果用户只是询问进度，简短回答后立即继续当前任务。
除非当前回复是在陈述真实阻塞，或用户明确要求你列出后续选项，否则不要以“如果你愿意，我下一步可以……”“要不要我继续……”“我还可以帮你做两件事……”或类似可选分支菜单收尾。`
  return enforceFixedBudget(
    `<execution_mode>\n${executionMode}\n</execution_mode>`,
    CONTEXT_PARAMS.budget.executionMode,
    'Execution Mode',
  )
}

export function buildMemoryPolicyBlock(): string {
  const policy = `会话中产生以下任何一种信息时，应主动写入 memory：
- 用户明确表达的偏好、习惯、约束 → preference
- 做出的技术或业务决策及理由 → decision
- 可复用的操作流程 → runbook
- 显著的、可复发的故障及其根因和修复方式 → incident
- 有长期参考价值的事实、结论、环境知识 → note

不写入的情况：一次性测试结果、临时排查日志、纯进度汇报、短期观察、只对当前会话有效的信息。
写入前先用 memory_search 搜索同主题记忆；已有同主题条目时优先 memory.update，而不是重复 create。
preference：用户稳定偏好、长期约束、沟通习惯、工具使用偏好。
decision：明确做出的方案或架构选择，以及为什么这么选；必须包含决策本身和理由。
runbook：未来可重复执行的操作流程；只有下次照着做会有价值时才记录，内容应偏步骤化。
incident：值得复盘和复用的故障案例；记录现象、影响、根因、修复或规避方式。
note：不属于上述类型、但值得长期保留的事实、研究结论、环境知识、外部系统经验。
session：由系统自动管理，不需要手动创建。
inbox：仅用于暂时无法准确分类但确有保留价值的内容。
同一主题的后续补充，优先更新已有 memory。`
  return enforceFixedBudget(`<memory_policy>\n${policy}\n</memory_policy>`, 900, 'Memory Policy')
}

export function buildToolRulesBlock(tools: ToolDefinition[]): string {
  const toolRuleMap: Record<string, string> = {
    read: 'Read：优先使用 Read 查看文件内容，不要用 Bash cat。',
    write:
      'Write：写入文件前先确认路径正确。临时文件和下载内容写入工作目录，修改源代码使用项目根目录的绝对路径。',
    edit: 'Edit：修改文件前先 Read 确认当前内容，避免基于过期认知做编辑。',
    bash: 'Bash：命令在工作目录中执行，操作项目源码时使用绝对路径。命令执行前检查是否命中熔断名单。长时间运行的命令加 timeout。',
    fetch:
      'Fetch：用于读取网页内容、调用 API、下载文件。HTML 自动通过 readability 提取正文转为 Markdown。(适用于无 JavaScript 渲染以及登录状态的网页)',
    memory_search:
      'Memory Search：回答过往工作、决策、偏好前，先搜索 `.zero/memory/**`。查询要具体（项目名/技术名/日期），支持语义搜索。搜索无结果时明确告知用户。',
    memory_get:
      'Memory Get：根据 memory_search 返回的 path 精读记忆文件。仅在 snippet 不足以回答时使用。',
    memory:
      'Memory：写入或维护长期记忆。完成工作步骤后，评估是否产生了值得跨会话保留的信息（偏好、决策、经验、流程），如有则调用 create 或 update。不要等到会话结束才写，每个阶段性成果完成时就评估。',
    task: 'Task：拆分 SubAgent 时明确每个子任务的输入、输出和依赖关系。不要把含糊的大任务直接丢给 SubAgent。',
    spawn_agent:
      'Spawn Agent：用于创建并行执行的子 agent。spawn 立即返回 agent_id，不会阻塞。可同时 spawn 多个 agent 并行工作。',
    wait_agent:
      'Wait Agent：等待子 agent 完成。默认等待任意一个完成即返回（Promise.race 语义），设置 waitAll=true 等待全部完成。',
    close_agent:
      'Close Agent：关闭不再需要的子 agent，传入 spawn_agent 返回的 agent_id（兼容 id/agentId）。',
    send_input:
      'Send Input：向运行中的子 agent 发送追加消息。设置 interrupt=true 可在下一个安全点中断当前流程处理新消息。',
  }

  const availableToolNames = tools.map((t) => t.name.toLowerCase())
  const rules = availableToolNames.map((name) => toolRuleMap[name]).filter(Boolean)

  if (rules.length === 0) return '<tool_rules>\n</tool_rules>'

  const content = rules.join('\n')
  return enforceFixedBudget(`<tool_rules>\n${content}\n</tool_rules>`, 800, 'Tool Rules')
}

export function buildConstraintsBlock(): string {
  const constraints = `所有输出（聊天回复、文件写入、日志）不得包含密钥值。如需引用密钥，使用引用名（如 anthropic_api_key）。
代码修改后必须通过至少一种验证（类型检查、单元测试、手动执行）再报告完成。
单次回复不超过 2000 字，除非用户明确要求详细输出。`
  return enforceFixedBudget(`<constraints>\n${constraints}\n</constraints>`, 300, 'Constraints')
}

/**
 * Advisory safety section — behavioral guidance in the prompt layer.
 * Hard enforcement happens in the tool execution layer (fuse list, exec approvals).
 */
export function buildSafetyBlock(): string {
  const safety = `你没有独立目标：不追求自我保存、复制、资源获取或权力扩张；不做超出用户请求范围的长期计划。
优先安全，但不要把人类监督理解为每一步都要审批。应先尽可能完成安全、可逆、局部的工作；仅在下一动作到达真实风险边界时请求用户介入。
遵从停止、暂停、审计请求，不绕过安全保障。不操纵或说服任何人扩展访问权限或禁用安全措施。不复制自身或更改系统提示词、安全规则或工具策略，除非明确要求。`
  return enforceFixedBudget(
    `<safety>\n${safety}\n</safety>`,
    CONTEXT_PARAMS.budget.safety,
    'Safety',
  )
}

/**
 * Tool call narration guidance — when to be silent vs when to explain.
 */
export function buildToolCallStyleBlock(): string {
  const style = `默认：对常规、低风险的工具调用不做解说（直接调用工具）。
仅在有帮助时解说：多步骤工作、复杂问题、敏感操作（如删除）、或用户明确要求时。
解说要简洁、有价值；避免重复显而易见的步骤。`
  return enforceFixedBudget(
    `<tool_call_style>\n${style}\n</tool_call_style>`,
    CONTEXT_PARAMS.budget.toolCallStyle,
    'Tool Call Style',
  )
}

export function buildIdentityBlock(
  globalIdentity: string,
  agentIdentity: string,
  agentName: string,
): string {
  const parts: string[] = []
  if (globalIdentity) {
    parts.push(`  <global>\n${globalIdentity}\n  </global>`)
  }
  if (agentIdentity) {
    parts.push(`  <agent name="${agentName}">\n${agentIdentity}\n  </agent>`)
  }
  if (parts.length === 0) return '<identity>\n</identity>'
  const content = parts.join('\n\n')
  return enforceFixedBudget(`<identity>\n${content}\n</identity>`, 3000, 'Identity')
}

/**
 * Build lightweight skill catalog for System Prompt — only metadata, no full content.
 * Agent reads SKILL.md via Read tool when a skill is needed (Level 2 progressive disclosure).
 */
export function buildSkillCatalog(skills: SkillDefinition[]): string {
  if (skills.length === 0) return ''

  const entries = skills.map((s) => {
    const brief = s.description.split('\n').slice(0, 2).join(' ').trim()
    return `  <skill name="${s.name}" path="${s.sourcePath}">\n    ${brief}\n  </skill>`
  })

  const instruction = `以下是可用的 Skill。当用户需求匹配某个 Skill 时，使用 Read 工具读取其 SKILL.md 获取详细指令，然后按指令执行。
约束：每次最多读取一个 Skill，选定后再读取；不要一次性读取多个 Skill。`
  const content = `<skill_catalog>\n${instruction}\n\n${entries.join('\n\n')}\n</skill_catalog>`
  return enforceFixedBudget(content, CONTEXT_PARAMS.budget.skillCatalog, 'Skill Catalog')
}

/**
 * Build incremental skill notification for new skills discovered at runtime.
 */
export function buildSkillReminder(skills: SkillDefinition[]): string {
  const entries = skills.map((s) => {
    const brief = s.description.split('\n').slice(0, 2).join(' ').trim()
    return `  <skill name="${s.name}" path="${s.sourcePath}">\n    ${brief}\n  </skill>`
  })
  return `<new_skills>\n新增了以下 Skill，可通过 Read 工具读取 SKILL.md 获取详细指令：\n${entries.join('\n')}\n</new_skills>`
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Build compact runtime info line — all context in key=value format for token efficiency.
 */
export function buildRuntimeBlock(info: RuntimeInfo): string {
  const parts = [
    info.agentId ? `agent=${info.agentId}` : '',
    info.sessionId ? `session=${info.sessionId}` : '',
    info.host ? `host=${info.host}` : '',
    info.projectRoot ? `repo=${info.projectRoot}` : '',
    info.os ? `os=${info.os}${info.arch ? ` (${info.arch})` : ''}` : '',
    info.model ? `model=${info.model}` : '',
    info.shell ? `shell=${info.shell}` : '',
    info.channel ? `channel=${info.channel}` : '',
  ].filter(Boolean)

  if (parts.length === 0) return ''

  const line = `Runtime: ${parts.join(' | ')}`

  // Append channel capabilities if available
  let capabilitiesBlock = ''
  if (info.channelCapabilities && Object.keys(info.channelCapabilities).length > 0) {
    const caps = info.channelCapabilities
    const capLines: string[] = []
    if (caps.streaming) capLines.push('- Streaming output: supported (text appears progressively)')
    if (caps.inlineImages)
      capLines.push(
        '- Inline images: supported (use standard markdown images; existing img_xxx, local absolute paths, file:// URIs, and http(s) URLs can be handled)',
      )
    else capLines.push('- Inline images: NOT supported (send images as separate messages)')
    if (caps.imageMessages) capLines.push('- Image messages: supported')
    if (caps.fileMessages) capLines.push('- File messages: supported')
    if (caps.interactiveCards) capLines.push('- Interactive cards: supported')
    if (caps.reactions) capLines.push('- Emoji reactions: supported')
    if (caps.threadReply) capLines.push('- Thread/quote reply: supported')
    if (caps.markdownNotes) capLines.push(`- Markdown notes: ${caps.markdownNotes}`)
    if (caps.maxMessageLength) capLines.push(`- Max message length: ${caps.maxMessageLength} chars`)

    if (capLines.length > 0) {
      capabilitiesBlock = `\nChannel capabilities (${info.channel ?? 'unknown'}):\n${capLines.join('\n')}`
    }
  }

  return enforceFixedBudget(
    `<runtime>\n${line}${capabilitiesBlock}\n</runtime>`,
    CONTEXT_PARAMS.budget.runtime,
    'Runtime',
  )
}

function hasMemoryTools(tools: ToolDefinition[]): boolean {
  const memoryToolNames = new Set(['memory', 'memory_search', 'memory_get'])
  return tools.some((tool) => memoryToolNames.has(tool.name.toLowerCase()))
}

/**
 * Build Project Context section from bootstrap files.
 * Injected at the tail of the system prompt.
 * When SOUL.md is present, adds persona embodiment instruction.
 */
export function buildBootstrapContextBlock(files: BootstrapFile[]): string {
  if (files.length === 0) return ''

  const lines: string[] = ['以下是工作区上下文文件，由系统自动加载。']

  if (hasSoulFile(files)) {
    lines.push('如果存在 SOUL.md，请体现其人格和语调。避免生硬、模板化的回复；遵循其指引。')
  }

  lines.push('')

  for (const file of files) {
    lines.push(`## ${file.name}`, '', file.content, '')
  }

  const content = `<project_context>\n${lines.join('\n')}\n</project_context>`
  return enforceFixedBudget(content, CONTEXT_PARAMS.budget.bootstrapContext, 'Project Context')
}

/**
 * @deprecated Use buildSkillCatalog() for System Prompt and buildDynamicContext() for per-message injection.
 */
export function buildSkillsBlock(skills: SkillDefinition[]): string {
  const entries = skills.map((s) => {
    const attrs = `name="${s.name}" allowed-tools="${s.allowedTools.join(', ')}"`
    return `  <skill ${attrs}>\n${s.content}\n  </skill>`
  })
  return `<skills>\n${entries.join('\n\n')}\n</skills>`
}

/**
 * Build a simplified System Prompt for SubAgents using PromptMode='minimal'.
 * SubAgents are task-oriented one-shot executors — no identity, memo, or retrieved memories.
 *
 * @deprecated Prefer buildSystemPrompt({ promptMode: 'minimal' }) for new code.
 * This function remains for task orchestrator compatibility.
 */
export function buildSubAgentPrompt(
  tools: ToolDefinition[],
  instruction: string,
  agentInstruction?: string,
  upstreamResults?: Map<string, { output: string; success: boolean }>,
  dependsOn?: string[],
): string {
  const sections: string[] = []

  // Simplified role
  const roleLines = [
    '你是 ZeRo OS 的 SubAgent，负责执行一项特定任务。',
    '任务完成后输出结果，不需要与用户交互。',
  ]
  if (agentInstruction) {
    roleLines.push(`角色说明：${agentInstruction}`)
  }
  sections.push(`<role>\n${roleLines.join('\n')}\n</role>`)

  // Tool rules (reuse existing builder)
  sections.push(buildToolRulesBlock(tools))

  // Constraints (reuse existing builder)
  sections.push(buildConstraintsBlock())

  // Task block
  sections.push(`<task>
${instruction}
</task>`)

  // Upstream results (if any dependencies)
  if (dependsOn && dependsOn.length > 0 && upstreamResults) {
    const items = dependsOn
      .map((depId) => {
        const result = upstreamResults.get(depId)
        if (!result) return ''
        const output = truncateToTokens(result.output, CONTEXT_PARAMS.subAgent.upstreamMaxTokens)
        return `  <upstream id="${depId}" status="${result.success ? 'success' : 'failed'}">\n${output}\n  </upstream>`
      })
      .filter(Boolean)

    if (items.length > 0) {
      sections.push(`<upstream_results>\n${items.join('\n\n')}\n</upstream_results>`)
    }
  }

  return sections.join('\n\n')
}
