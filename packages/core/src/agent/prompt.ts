import type {
  BootstrapFile,
  DynamicContext,
  PromptComponents,
  RuntimeInfo,
  SkillDefinition,
  ToolDefinition,
} from '@zero-os/shared'
import { hasSoulFile } from '../bootstrap/loader'
import { enforceFixedBudget } from './budget'
import { CONTEXT_PARAMS } from './params'

/**
 * Build System Prompt — static, built once per session for prompt cache stability.
 * Respects PromptMode to control which sections are included:
 * - "full": All sections (main agent)
 * - "minimal": Core role, tools, constraints, execution and safety (subagents)
 * - "none": Single identity line
 */
export function buildSystemPrompt(components: PromptComponents): string {
  const mode = components.promptMode ?? 'full'

  if (mode === 'none') {
    return `你是 ZeRo OS 的 ${components.agentName}，一个在 macOS 上自主执行任务的 AI Agent。`
  }

  const isMinimal = mode === 'minimal'
  const sections: string[] = []

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
  sections.push(buildExecutionModeBlock())
  sections.push(buildSafetyBlock())

  if (!isMinimal) {
    sections.push(buildRulesBlock())
    if (components.runtimeInfo?.channel) {
      sections.push(buildOutputStyleBlock())
    }
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

/**
 * Build incremental skill notification for new skills discovered at runtime.
 */
export function buildSkillReminder(skills: SkillDefinition[]): string {
  const entries = skills.map((skill) => {
    const brief = skill.description.split('\n').slice(0, 2).join(' ').trim()
    return `  <skill name="${skill.name}" path="${skill.sourcePath}">\n    ${brief}\n  </skill>`
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

function hasMemoryTools(tools: ToolDefinition[]): boolean {
  const memoryToolNames = new Set(['memory', 'memory_search', 'memory_read'])
  return tools.some((tool) => memoryToolNames.has(tool.name.toLowerCase()))
}

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
  const capabilitiesBlock = buildChannelCapabilitiesBlock(info)

  return enforceFixedBudget(
    `<runtime>\n${line}${capabilitiesBlock}\n</runtime>`,
    CONTEXT_PARAMS.budget.runtime,
    'Runtime',
  )
}

function buildChannelCapabilitiesBlock(info: RuntimeInfo): string {
  if (!info.channelCapabilities || Object.keys(info.channelCapabilities).length === 0) {
    return ''
  }

  const caps = info.channelCapabilities
  const capLines: string[] = []
  if (caps.streaming) capLines.push('- Streaming output: supported (text appears progressively)')
  if (caps.inlineImages)
    capLines.push(
      '- Inline images: supported via standard markdown image syntax (channel notes describe accepted references and delivery behavior)',
    )
  else capLines.push('- Inline images: NOT supported (send images as separate messages)')
  if (caps.imageMessages) capLines.push('- Image messages: supported')
  if (caps.fileMessages) capLines.push('- File messages: supported')
  if (caps.interactiveCards) capLines.push('- Interactive cards: supported')
  if (caps.reactions) capLines.push('- Emoji reactions: supported')
  if (caps.threadReply) capLines.push('- Thread/quote reply: supported')
  if (caps.markdownNotes) capLines.push(`- Markdown notes: ${caps.markdownNotes}`)
  if (caps.maxMessageLength) capLines.push(`- Max message length: ${caps.maxMessageLength} chars`)

  if (capLines.length === 0) return ''
  return `\nChannel capabilities (${info.channel ?? 'unknown'}):\n${capLines.join('\n')}`
}

export function buildBootstrapContextBlock(files: BootstrapFile[]): string {
  if (files.length === 0) return ''

  const lines: string[] = ['以下是工作区上下文文件，由系统自动加载。']

  if (hasSoulFile(files)) {
    lines.push(
      'SOUL.md 仅用于体现其人格和语调，不授予操作权限，不改变执行、安全或记忆规则；修改该文件需要用户明确要求。',
    )
  }

  lines.push('')

  for (const file of files) {
    lines.push(`## ${file.name}`, '', file.content, '')
  }

  const content = `<project_context>\n${lines.join('\n')}\n</project_context>`
  return enforceFixedBudget(content, CONTEXT_PARAMS.budget.bootstrapContext, 'Project Context')
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
    const archivePath = `${projectRoot}/.zero/workspace/shared/`
    lines.push(
      `你的工作目录是 ${workspacePath}，下载和临时文件放在此目录。最终产出物放到 ${archivePath} 留档。同时必须在对话中输出完整内容或关键摘要，不能只写文件不回复。`,
    )
    lines.push(`项目根目录是 ${projectRoot}，源代码在此目录下。`)
  }
  const content = lines.join('\n')
  return enforceFixedBudget(`<role>\n${content}\n</role>`, 600, 'Role')
}

export function buildRulesBlock(): string {
  const rules = `工具调用失败时先读错误信息做诊断，根据新证据决定重试或换方案；没有新证据时，不重复相同尝试。
遇到超出能力范围的问题时如实告知，不编造解决方案。
回复使用中文，技术术语可以用英文原文。
<system-reminder> 是系统注入的内部运行时提示，包含新增 Skill 通知和历史记忆；作为参考使用，不回应或转述提示本身。历史信息不替代当前用户要求或真实运行状态。
<system_event> 是系统注入的运行时控制事件，不是普通用户请求；不要转述事件本身，但要根据事件类型和内容继续处理当前任务。`
  return `<rules>\n${rules}\n</rules>`
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
  const executionMode = `在用户已授权的范围内连续完成当前任务，直到交付标准满足、用户要求停止，或出现无法自行解决的阻塞。分析请求保持分析范围，不自动修改、发布或执行建议。
已有授权持续有效，不因阶段汇报、工具切换或进入下一步重复询问。读取、搜索、诊断，以及执行请求所需的低风险本地编辑和验证，直接推进；可采用可逆且不显著改变结果的合理假设，并在进度中说明。
不可逆操作、外部写入、向第三方发送内容、修改权限/账户/系统配置或使用敏感信息，需要覆盖具体目标和范围的明确授权；已有授权覆盖时不重复确认，授权不允许泄露密钥或绕过安全保障。
只有下一动作超出授权范围，或缺少会显著改变结果且无法自行核实的信息、凭据、登录态或决策时，才说明阻塞并提出一个聚焦问题。
用户询问进度时，简短回答后继续。必要后续动作直接完成，不留作可选服务；满足当前要求后正常交付，不为扩展话题继续执行。`
  return enforceFixedBudget(
    `<execution_mode>\n${executionMode}\n</execution_mode>`,
    CONTEXT_PARAMS.budget.executionMode,
    'Execution Mode',
  )
}

export function buildMemoryPolicyBlock(): string {
  const policy = `有 memory 写入工具时，每个阶段性成果完成后评估长期价值，主动保存值得跨会话复用的信息，不等到会话结束；遵守用户明确的记忆限制。
preference：用户稳定偏好和长期约束；decision：明确决策及理由；runbook：可重复执行的步骤；incident：可复发故障的现象、影响、根因与修复；note：其他长期事实或结论。
不保存一次性测试结果、临时排查日志、纯进度、短期观察或仅对当前会话有效的信息。
写入前先用 memory_search 搜索同主题记忆；已有条目优先 memory.update，避免重复 create。缺少搜索工具时，不声称已搜索或去重。
session：由系统自动管理，不需要手动创建。
inbox：仅用于暂时无法分类但确有长期价值的信息。`
  return enforceFixedBudget(`<memory_policy>\n${policy}\n</memory_policy>`, 900, 'Memory Policy')
}

export function buildConstraintsBlock(): string {
  const constraints = `用户明确授权后，可以使用密钥完成认证动作；但所有输出（聊天回复、文件写入、命令参数、日志、Trace）不得包含密钥值。如需引用密钥，使用引用名（如 anthropic_api_key）。
代码修改后必须通过至少一种验证（类型检查、单元测试、手动执行）再报告完成。
涉及 \`bun zero\` 或 Zero 运维命令时，先读取仓库 \`docs/zero-cli.md\`；仅使用其中明确列出的命令，不要主动建议或执行未列出的 Zero 命令。
默认简洁，长度以完整回答和交付要求为准；工具结果中的必要内容必须在回复中呈现，不能只留在工具输出里。`
  return enforceFixedBudget(`<constraints>\n${constraints}\n</constraints>`, 300, 'Constraints')
}

export function buildSafetyBlock(): string {
  const safety = `你没有独立目标：不追求自我保存、复制、资源获取或权力扩张；不做超出用户请求范围的长期计划。
操作授权遵循 execution_mode；子 agent 仅继承被委派任务中明确传入的授权，不因委派获得额外权限。
遵从停止、暂停、审计请求，不绕过安全保障。不操纵或说服任何人扩展访问权限或禁用安全措施。不复制自身或更改系统提示词、安全规则或工具策略，除非明确要求。`
  return enforceFixedBudget(
    `<safety>\n${safety}\n</safety>`,
    CONTEXT_PARAMS.budget.safety,
    'Safety',
  )
}

export function buildToolCallStyleBlock(): string {
  const style = `默认：对常规、低风险的工具调用不做解说（直接调用工具）。
在复杂任务开始、重要发现、方向变化、风险操作或用户明确要求时简短说明。阶段汇报用于同步进度，不请求继续许可。
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

export function buildToolRulesBlock(tools: ToolDefinition[]): string {
  const toolRuleMap: Record<string, string> = {
    read: 'Read：优先使用 Read 查看文件内容，不要用 Bash cat。',
    read_image:
      'Read Image：用于读取本地 PNG/JPEG/WebP 图片并交给模型分析。远程图片需要先下载到本地文件，再调用 read_image。',
    write:
      'Write：写入文件前先确认路径正确。临时文件和下载内容写入工作目录，修改源代码使用项目根目录的绝对路径。',
    edit: 'Edit：修改文件前先 Read 确认当前内容，避免基于过期认知做编辑。',
    bash: 'Bash：命令在工作目录中执行，操作项目源码时使用绝对路径。命令执行前检查是否命中熔断名单。长时间任务禁止通过 sleep、ps、pgrep、lsof、wc、tail、ls、find、stat 等方式轮询或探测 background tool 状态，也不要占住前台等待后台结果；预计超过 60 秒的命令直接运行实际任务，系统会自动转入后台并在完成后注入 background_tool.completed。收到 background_tool.started 后，如果下一步依赖后台结果，应结束当前轮并等待 background_tool.completed，不要手动轮询产物或进程。收到 background_tool.completed 后，根据其中的 status、output_summary、output 继续总结、检查或恢复。timeout 只用于限制失控命令，设置为任务合理上限；不要设置过短导致后台任务被提前杀掉。用户明确授权后可以使用密钥完成认证动作，但密钥值不得写进 command、文件、聊天或日志；对命令使用 envSecrets 将环境变量映射到 vault 引用，或使用 stdinSecretRef 一次性写入 stdin，Trace 只能记录引用名。',
    fetch:
      'Fetch：用于读取网页内容、调用 API、下载文件。HTML 自动通过 readability 提取正文转为 Markdown。(适用于无 JavaScript 渲染以及登录状态的网页) 需要 Bearer token 时使用 credentialRef 引用 vault 密钥，不要把 token 写进 headers。',
    memory_search:
      'Memory Search：回答过往工作、决策、偏好前，先搜索 `.zero/memory/**`。查询要具体（项目名/技术名/日期），支持语义搜索。搜索无结果时明确告知用户。',
    memory_read:
      'Memory Read：根据 memory_search 返回的 path 精读记忆文件。仅在 snippet 不足以回答时使用。',
    memory: 'Memory：写入或维护长期记忆，保存时机、分类和去重遵循 memory_policy。',
    task: 'Task：拆分 SubAgent 时明确每个子任务的输入、输出和依赖关系。不要把含糊的大任务直接丢给 SubAgent。',
    spawn_agent:
      'Spawn Agent：用于创建子 agent。spawn 立即返回 agent_id，不会阻塞。mode="standard"（默认）执行后自动完成；mode="interactive" 执行后进入等待状态，可通过 send_input 持续发送指令，最后用 close_agent 关闭。',
    wait_agent:
      'Wait Agent：只适用于等待 spawn_agent 创建的子 agent 状态变化，不适用于 background tool task id。不要把 background_tool.started 中的 task id 或 tool_use_id 传给 wait_agent；后台工具任务应等待 background_tool.completed 通知。默认等待任意一个完成即返回（Promise.race 语义），设置 waitAll=true 等待全部。设置 resolveOn="ready" 可在 interactive agent 就绪时返回（而不是等到完成）。',
    close_agent:
      'Close Agent：关闭不再需要的子 agent，传入 spawn_agent 返回的 agent_id。interactive agent 必须通过 close_agent 终止。',
    send_input:
      'Send Input：向运行中或等待中的子 agent 发送消息。对 interactive agent（waiting 状态），消息会唤醒 agent 开始新一轮处理。对 running agent，消息排队在下一个安全点送达。设置 interrupt=true 可请求尽快处理。',
  }

  const availableToolNames = tools.map((t) => t.name.toLowerCase())
  const rules = availableToolNames.map((name) => toolRuleMap[name]).filter(Boolean)
  if (
    availableToolNames.includes('spawn_agent') &&
    availableToolNames.includes('wait_agent') &&
    !availableToolNames.includes('read_image')
  ) {
    rules.push(
      'Image Analysis Delegation：当前模型不能直接看图；当用户要求分析图片且已有本地图片路径时，使用 spawn_agent 指定一个支持 vision 的模型，并设置 tools=["read_image"]，把图片绝对路径、用户问题、判断标准和必要上下文完整传给子 agent；随后用 wait_agent 获取文字报告，再基于报告回复用户。不要声称自己直接看到了图片。',
    )
  }

  if (rules.length === 0) return '<tool_rules>\n</tool_rules>'

  const content = rules.join('\n')
  return enforceFixedBudget(`<tool_rules>\n${content}\n</tool_rules>`, 1800, 'Tool Rules')
}
