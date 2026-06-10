import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnthropicDeepSeekAdapter, type ProviderAdapter } from '@zero-os/model'
import type { TraceEntry } from '@zero-os/observe'
import { Vault, getMasterKey } from '@zero-os/secrets'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  StreamEvent,
} from '@zero-os/shared'
import {
  TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT,
  extractAssistantText,
  parseTaskClosureDecision,
} from '../../../packages/core/src/agent/task-closure'
import { collapseTraceEntries } from '../../../packages/observe/src/trace'

export type TaskClosureAction = 'finish' | 'continue' | 'block'
export type TaskClosureSecretSource = 'vault' | 'env'
export type TaskClosureSampleSource = 'trace' | 'closure'

export interface TaskClosurePromptBenchmarkOptions {
  logsDir: string
  outDir: string
  sessionIds?: string[]
  variants?: string[]
  labels?: Array<TaskClosureAction | 'failed'>
  all: boolean
  limit: number
  reps: number
  concurrency: number
  model: string
  secretSource: TaskClosureSecretSource
  resolveHost?: string
  maxTokens: number
  dryRun: boolean
  resume: boolean
}

interface TaskClosurePromptFields {
  userMessage: string
  assistantText: string
  assistantTail: string
  toolSummary: string
  appliedQueuedMessages?: string
}

export interface TaskClosurePromptVariant {
  id: string
  title: string
  hypothesis: string
  buildPrompt: (fields: TaskClosurePromptFields) => string
}

export interface TaskClosurePromptSample {
  id: string
  source: TaskClosureSampleSource
  sessionId: string
  spanId: string
  sourcePath: string
  ts: string
  historicalEvent: 'task_closure_decision' | 'task_closure_failed'
  expectedAction?: TaskClosureAction
  historicalReason?: string
  failureStage?: string
  promptChars: number
  assistantChars: number
  assistantTailChars: number
  toolSummaryChars: number
  hasAppliedQueuedMessages: boolean
  fields: TaskClosurePromptFields
}

export interface TaskClosurePromptRunResult {
  variantId: string
  variantTitle: string
  rep: number
  sampleId: string
  sessionId: string
  expectedAction?: TaskClosureAction
  historicalEvent: 'task_closure_decision' | 'task_closure_failed'
  parseOk: boolean
  action?: TaskClosureAction
  reason?: string
  matchesHistorical?: boolean
  model: string
  inputTokens: number
  outputTokens: number
  durationMs: number
  promptChars: number
  responseChars: number
  responsePreview?: string
  error?: string
}

export interface TaskClosurePromptVariantSummary {
  variantId: string
  title: string
  hypothesis: string
  runCount: number
  requestErrorCount: number
  parseFailCount: number
  parseRate: number
  labeledRunCount: number
  historicalMatchRate: number | null
  blockRecall: number | null
  continueRecall: number | null
  finishRecall: number | null
  avgInputTokens: number
  avgOutputTokens: number
  avgDurationMs: number
  predictedActionCounts: Record<string, number>
  confusionMatrix: Record<TaskClosureAction, Record<string, number>>
}

export interface TaskClosurePromptBenchmarkReport {
  generatedAt: string
  model: string
  logsDir: string
  options: {
    all: boolean
    limit: number
    reps: number
    concurrency: number
    maxTokens: number
    dryRun: boolean
    resume: boolean
    sessionIds?: string[]
    variants?: string[]
    labels?: Array<TaskClosureAction | 'failed'>
    resolveHost?: string
  }
  inventory: TaskClosureInventory
  variants: Array<Omit<TaskClosurePromptVariant, 'buildPrompt'>>
  samples: Array<Omit<TaskClosurePromptSample, 'fields'>>
  summaries: TaskClosurePromptVariantSummary[]
  results: TaskClosurePromptRunResult[]
}

interface TaskClosureInventory {
  sessionDirectoryCount: number
  traceFileCount: number
  rawTraceLineCount: number
  traceTaskClosureEventCount: number
  closureFileCount: number
  rawClosureLineCount: number
  closureTaskClosureEventCount: number
  closurePromptCandidateCount: number
  taskClosureEventCount: number
  extractedSampleCount: number
  duplicateSampleCount: number
  skippedPromptCount: number
  allActionCounts: Record<string, number>
  selectedActionCounts: Record<string, number>
}

interface TraceFileRead {
  path: string
  entries: TraceEntry[]
  rawLineCount: number
}

interface TaskClosureRawSample {
  source: TaskClosureSampleSource
  sourcePath: string
  sessionId: string
  spanId: string
  ts: string
  closure: Record<string, unknown>
}

interface ClosureFileEntry {
  lineNumber: number
  value: Record<string, unknown>
}

interface ClosureFileRead {
  path: string
  entries: ClosureFileEntry[]
  rawLineCount: number
}

const DEFAULT_OUT_DIR = join(
  '.artifacts',
  'task-closure-prompt-bench',
  new Date().toISOString().replace(/[:.]/g, '-'),
)

export const TASK_CLOSURE_PROMPT_VARIANTS: TaskClosurePromptVariant[] = [
  {
    id: 'V0_BASELINE_FULL_PLUS_TAIL',
    title: 'Baseline full text plus tail',
    hypothesis:
      'Current production shape. It keeps full assistant text and repeats the closing tail.',
    buildPrompt: (fields) =>
      buildPromptWithInstruction(fields, BASELINE_INSTRUCTION, {
        assistantMode: 'full-plus-tail',
      }),
  },
  {
    id: 'V1_TAIL_ONLY',
    title: 'Tail only',
    hypothesis:
      'Aggressive token cut. Focuses on closing wording but may lose completion evidence.',
    buildPrompt: (fields) =>
      buildPromptWithInstruction(fields, TAIL_ONLY_INSTRUCTION, {
        assistantMode: 'tail-only',
      }),
  },
  {
    id: 'V2_FULL_NO_TAIL',
    title: 'Full text without tail block',
    hypothesis: 'Removes duplicate tail while preserving the complete answer as evidence.',
    buildPrompt: (fields) =>
      buildPromptWithInstruction(fields, FULL_NO_TAIL_INSTRUCTION, {
        assistantMode: 'full-no-tail',
      }),
  },
  {
    id: 'V3_DEDUP_BODY_PLUS_TAIL',
    title: 'Body plus non-duplicated tail',
    hypothesis: 'Keeps an explicit closing focus without repeating the same text twice.',
    buildPrompt: (fields) =>
      buildPromptWithInstruction(fields, BASELINE_INSTRUCTION, {
        assistantMode: 'dedup-body-plus-tail',
      }),
  },
  {
    id: 'V4_TAIL_FIRST_CHECKLIST',
    title: 'Tail first with decision checklist',
    hypothesis:
      'Highlights the closing sentence first, then verifies against body and tool evidence.',
    buildPrompt: (fields) =>
      buildPromptWithInstruction(fields, TAIL_FIRST_CHECKLIST_INSTRUCTION, {
        assistantMode: 'tail-first-dedup-body',
      }),
  },
  {
    id: 'V5_JSON_FIRST_DEDUP_TAIL',
    title: 'JSON first deduplicated tail',
    hypothesis:
      'Keeps the V3 non-duplicated structure but makes the final answer start with JSON immediately.',
    buildPrompt: (fields) =>
      buildPromptWithInstruction(fields, JSON_FIRST_DEDUP_INSTRUCTION, {
        assistantMode: 'dedup-body-plus-tail',
      }),
  },
  {
    id: 'V6_JSON_FIRST_EVIDENCE_GUARD',
    title: 'JSON first with evidence guard',
    hypothesis:
      'Adds a hard guard for unsupported completion claims and user-auth/permission blockers.',
    buildPrompt: (fields) =>
      buildPromptWithInstruction(fields, JSON_FIRST_EVIDENCE_GUARD_INSTRUCTION, {
        assistantMode: 'dedup-body-plus-tail',
      }),
  },
  {
    id: 'V7_JSON_FIRST_BOUNDED_EVIDENCE',
    title: 'JSON first with bounded evidence guard',
    hypothesis:
      'Keeps the V5 JSON-first shape while adding a shorter evidence guard that exempts text deliverables.',
    buildPrompt: (fields) =>
      buildPromptWithInstruction(fields, JSON_FIRST_BOUNDED_EVIDENCE_INSTRUCTION, {
        assistantMode: 'dedup-body-plus-tail',
      }),
  },
  {
    id: 'V8_JSON_FIRST_EXTERNAL_ACTION_BOUNDARY',
    title: 'JSON first with external action boundary',
    hypothesis:
      'Separates text deliverables from external-state actions and caps the reason to reduce truncation.',
    buildPrompt: (fields) =>
      buildPromptWithInstruction(fields, JSON_FIRST_EXTERNAL_ACTION_BOUNDARY_INSTRUCTION, {
        assistantMode: 'dedup-body-plus-tail',
      }),
  },
  {
    id: 'V9_JSON_FIRST_GOAL_AUDIT',
    title: 'JSON first with Codex goal-style audit',
    hypothesis:
      'Adapts Codex goal completion-audit semantics to preserve scope while avoiding optional-followup overreach.',
    buildPrompt: (fields) =>
      buildPromptWithInstruction(fields, JSON_FIRST_GOAL_AUDIT_INSTRUCTION, {
        assistantMode: 'dedup-body-plus-tail',
      }),
  },
  {
    id: 'V10_JSON_FIRST_COMPACT_GOAL_AUDIT',
    title: 'JSON first with compact Codex goal audit',
    hypothesis:
      'Keeps the Codex goal audit boundary but removes wording that invites verbose reasoning.',
    buildPrompt: (fields) =>
      buildPromptWithInstruction(fields, JSON_FIRST_COMPACT_GOAL_AUDIT_INSTRUCTION, {
        assistantMode: 'dedup-body-plus-tail',
      }),
  },
]

const BASELINE_INSTRUCTION = `<instruction>
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
</instruction>`

const FULL_NO_TAIL_INSTRUCTION = `<instruction>
你是一个任务收尾判定器。请判断 assistant 的收尾是否把当前任务的必要后续动作包装成了可选下一步。

判定原则：
- 如果 assistant 已经完整回答用户问题，返回 finish。
- 如果 assistant 只是把完成当前问题所必需的低成本后续动作写成了“如果你愿意，我可以继续……”，返回 continue。
- 如果 assistant 明确缺少用户提供的信息、授权、凭据、登录态，或下一步涉及不可逆外部动作，返回 block。
- 如果 assistant 声称已完成某操作，且 <tool_calls_this_turn> 中有对应的成功工具调用记录，该操作视为已实际执行，不属于虚假确认，应返回 finish 而非 block。
- 只有当用户明确要求”给我下一步选项 / 后续选项 / 还能做什么”时，菜单式收尾才算 finish。
- 重点检查 <assistant_text> 的结尾段落；不要因为缺少单独 tail 字段就忽略收尾措辞。

研究/分析类任务额外规则：
- 如果用户要求分析、深入分析、研究、核验，或要求把“相关信息 / 相关线索”也一起分析，不能因为 assistant 已经给出一版总结就直接返回 finish。
- 对研究/分析类任务，只有当 assistant 已覆盖原始材料的关键主张、扩展到主要相关信息、尽可能做了多源交叉验证，并明确区分已证实与未证实部分时，才可返回 finish。
- 如果 assistant 当前更像第一轮读后总结、只分析了单一来源、或仍明确指出还有重要相关线索/来源值得继续查证，则返回 continue。
- 如果继续查证、补充相关信息、拆分关键主张，会实质提升回答质量而不是只做边际润色，则返回 continue。

返回一行合法 JSON，不要解释、代码块、Markdown 或额外文本：
{"action":"finish|continue|block","reason":"简短原因"}
</instruction>`

const TAIL_ONLY_INSTRUCTION = `<instruction>
你是一个任务收尾判定器。请只根据用户消息、工具调用摘要和 assistant 的最后收尾片段判断是否需要继续。

判定原则：
- 如果收尾片段已经明确交付结果，返回 finish。
- 如果收尾片段把当前任务必要的低成本后续动作包装成“如果你愿意，我可以继续……”，返回 continue。
- 如果收尾片段说明缺少用户信息、授权、凭据、登录态，或下一步涉及不可逆外部动作，返回 block。
- 如果工具摘要显示对应操作已经成功执行，不要把“已完成”判为虚假确认。
- 用户明确要求下一步选项时，菜单式收尾可返回 finish。

返回一行合法 JSON，不要解释、代码块、Markdown 或额外文本：
{"action":"finish|continue|block","reason":"简短原因"}
</instruction>`

const TAIL_FIRST_CHECKLIST_INSTRUCTION = `<instruction>
你是一个任务收尾判定器。请先看 assistant 的收尾片段，再用正文和工具调用摘要校验。

判定顺序：
1. 收尾是否把当前任务必要动作说成“如果你愿意/要不要/我可以继续”的可选菜单？如果是，优先考虑 continue。
2. 正文和工具调用是否已经证明用户请求被完成？如果是，返回 finish。
3. 是否缺少用户提供的信息、授权、凭据、登录态，或下一步涉及不可逆外部动作？如果是，返回 block。
4. 用户是否明确要求“下一步选项/后续选项/还能做什么”？如果是，菜单式收尾不算问题，可返回 finish。

研究/分析类任务：
- 如果用户要求分析、深入分析、研究、核验，或要求相关线索一起分析，只有覆盖关键主张、主要相关信息、多源交叉验证，并区分已证实与未证实时才返回 finish。
- 如果当前只是初步总结、单一来源分析，或 assistant 自己指出还有重要线索值得查证，返回 continue。

返回一行合法 JSON，不要解释、代码块、Markdown 或额外文本：
{"action":"finish|continue|block","reason":"简短原因"}
</instruction>`

const JSON_FIRST_DEDUP_INSTRUCTION = `<instruction>
你是一个任务收尾判定器。你的最终正文必须只包含一行 JSON，第一字符必须是 {，不要在最终正文中输出分析、解释、Markdown 或代码块。

判定目标：
- 判断 assistant 是否已经完成当前用户任务，或是否把必要后续动作包装成可选下一步。

判定原则：
- 如果 assistant 已经完整回答用户问题，返回 finish。
- 如果 assistant 把当前任务必要的低成本后续动作写成“如果你愿意/如果你要/要不要我/我可以继续”之类可选菜单，返回 continue。
- 如果 assistant 明确缺少用户信息、授权、凭据、登录态，或下一步涉及不可逆外部动作，返回 block。
- 如果 <tool_calls_this_turn> 显示对应操作已成功执行，不要把已完成陈述判成 block。
- 用户明确要求“下一步选项/后续选项/还能做什么”时，菜单式收尾可返回 finish。

研究/分析类任务：
- 如果用户要求分析、深入分析、研究、核验，或要求相关线索一起分析，只有覆盖关键主张、主要相关信息、多源交叉验证，并区分已证实与未证实时才返回 finish。
- 如果当前只是初步总结、单一来源分析，或 assistant 自己指出还有重要线索值得查证，返回 continue。

输出格式：
{"action":"finish|continue|block","reason":"简短原因"}
</instruction>`

const JSON_FIRST_EVIDENCE_GUARD_INSTRUCTION = `<instruction>
你是一个任务收尾判定器。你的最终正文必须只包含一行 JSON，第一字符必须是 {，不要在最终正文中输出分析、解释、Markdown 或代码块。

判定目标：
- 判断 assistant 是否已经完成当前用户任务，或是否把必要后续动作包装成可选下一步。

硬性阻塞规则（优先于 finish）：
- 如果 assistant 声称已经执行文件修改、删除、部署、上传、发布、启动服务、网络探测、生成图片/草稿/报告等可验证动作，但 <tool_calls_this_turn> 没有对应成功记录，返回 block。
- 如果 <tool_calls_this_turn> 中对应关键动作失败、超时、被拒绝、缺少登录态、缺少 sudo/凭据/授权/白名单/权限，返回 block。
- 如果下一步需要用户确认发布、审核草稿、选择方案、提供缺失任务目标、登录、输入密码、提供凭据或授权不可逆外部操作，返回 block。
- 不要把上述真实阻塞降级成 continue；continue 只用于 assistant 可以自己低成本继续执行的任务。

普通判定：
- 如果 assistant 已经完整回答用户问题，且没有触发硬性阻塞规则，返回 finish。
- 如果 assistant 把当前任务必要的低成本后续动作写成“如果你愿意/如果你要/要不要我/我可以继续”之类可选菜单，返回 continue。
- 用户明确要求“下一步选项/后续选项/还能做什么”时，菜单式收尾可返回 finish。

研究/分析类任务：
- 如果用户要求分析、深入分析、研究、核验，或要求相关线索一起分析，只有覆盖关键主张、主要相关信息、多源交叉验证，并区分已证实与未证实时才返回 finish。
- 如果当前只是初步总结、单一来源分析，或 assistant 自己指出还有重要线索值得查证，且 assistant 可以自行继续，返回 continue。

输出格式：
{"action":"finish|continue|block","reason":"简短原因"}
</instruction>`

const JSON_FIRST_BOUNDED_EVIDENCE_INSTRUCTION = `<instruction>
你是一个任务收尾判定器。最终正文只输出一行 JSON，第一字符必须是 {，不要输出分析、Markdown 或代码块。

判定目标：
- 判断 assistant 是否已完成当前用户任务，或是否把必要后续动作包装成可选下一步。

判定优先级：
1. 如果缺少用户信息、登录态、凭据、授权、密码、确认发布/审核/不可逆外部动作，返回 block。
2. 如果关键工具调用失败、超时、被拒绝或权限不足，且用户任务仍依赖该动作，返回 block。
3. 如果 assistant 声称已修改/删除/上传/部署/发送/发布/生成文件或图片等可验证动作，但 <tool_calls_this_turn> 没有对应成功记录，且正文没有直接给出可检查的交付物，返回 block。
4. 如果任务必要的低成本后续动作仍可由 assistant 自行完成，却被写成“如果你愿意/要不要我/我可以继续”，返回 continue。
5. 如果答案或交付物已在正文中给出，或关键动作有成功工具记录，返回 finish。

补充规则：
- 分析、解释、翻译、改写、整理、贴全文等文本交付，正文内容本身可作为完成证据，不强求工具记录。
- 用户明确要求“下一步选项/后续选项/还能做什么”时，菜单式收尾可返回 finish。
- 研究/核验类任务如果仍只有初步总结、单一来源，或 assistant 自己指出还有重要线索可自行查证，返回 continue。

输出格式：
{"action":"finish|continue|block","reason":"简短原因"}
</instruction>`

const JSON_FIRST_EXTERNAL_ACTION_BOUNDARY_INSTRUCTION = `<instruction>
你是一个任务收尾判定器。最终正文只输出一行 JSON，第一字符必须是 {，不要输出分析、Markdown 或代码块。

判定目标：
- 判断 assistant 是否已完成当前用户任务，或是否把必要后续动作包装成可选下一步。

判定优先级：
1. 缺少用户信息、登录态、凭据、授权、密码、确认发布/审核/不可逆外部动作时，返回 block。
2. 外部状态动作必须有 <tool_calls_this_turn> 对应成功记录才可 finish；否则如果仍是用户任务的必要部分，返回 block。
3. 外部状态动作包括：网络探测、启动服务、部署、上传、发布、创建/更新草稿、修改/删除文件、生成图片/视频/文件、发送消息/API 请求。
4. 文本交付不属于外部状态动作；分析、解释、翻译、改写、整理、贴全文等，只要正文已给出可检查内容，可返回 finish。
5. 如果任务必要的低成本后续动作仍可由 assistant 自行完成，却被写成“如果你愿意/要不要我/我可以继续”，返回 continue。
6. 用户明确要求“下一步选项/后续选项/还能做什么”时，菜单式收尾可返回 finish。
7. 研究/核验类任务如果仍只有初步总结、单一来源，或 assistant 自己指出还有重要线索可自行查证，返回 continue。

输出格式，reason 不超过 40 个中文字符：
{"action":"finish|continue|block","reason":"..."}
</instruction>`

const JSON_FIRST_GOAL_AUDIT_INSTRUCTION = `<instruction>
你是一个任务收尾判定器。最终正文只输出一行 JSON，第一字符必须是 {，不要输出分析、Markdown 或代码块。

参考 Codex goal 的完成审计方式：
- 先从 <user_message> 推导当前任务的必要要求，保持原始范围，不要把任务缩小成 assistant 已经做过的部分。
- 再用 <assistant_body_without_tail>、<assistant_tail> 和 <tool_calls_this_turn> 判断每个必要要求是否已被证据证明。
- 完成必须由正文交付物或成功工具记录证明；不能只因 assistant 声称完成、表达自信、或没有明显报错就判 finish。
- 但也不要把独立增强、可选优化、礼貌性后续邀请当成未完成。

判定规则：
1. 所有必要要求都有足够证据，且剩余内容只是可选增强或用户明确要求的后续选项，返回 finish。
2. 必要要求仍缺少低成本工作，且 assistant 可以自行继续完成，却把它写成“如果你愿意/要不要我/我可以继续”，返回 continue。
3. 缺少用户信息、选择、登录态、密码、凭据、授权、确认发布/审核，或下一步是不可逆外部动作，返回 block。
4. 修改/删除文件、部署、上传、发布、创建/更新草稿、生成文件或图片、发送消息/API 请求、启动服务、网络探测等外部状态动作，需要 <tool_calls_this_turn> 中有对应成功记录才可作为完成证据。
5. 分析、解释、翻译、改写、整理、贴全文等文本交付，正文内容本身可作为完成证据。
6. 研究/核验类任务如果仍只是初步总结、单一来源，或 assistant 明确指出还有重要线索可自行查证，返回 continue；如果只是可选深入，返回 finish。

输出格式，reason 不超过 40 个中文字符：
{"action":"finish|continue|block","reason":"..."}
</instruction>`

const JSON_FIRST_COMPACT_GOAL_AUDIT_INSTRUCTION = `<instruction>
你是任务收尾判定器。只输出一行 JSON；第一字符必须是 {；禁止输出推理、解释、Markdown、代码块。

按 Codex goal 风格判定：
- 从 <user_message> 保持原始任务范围；不要把任务缩小成 assistant 已做的部分。
- finish 需要正文交付物或成功工具记录证明所有必要要求已完成。
- continue 用于：必要要求仍可由 assistant 自行低成本完成，却被写成可选后续。
- block 用于：缺少用户信息/选择/登录/密码/凭据/授权/确认，或需要用户批准不可逆外部动作。
- 外部状态动作要有对应成功工具记录：修改/删除文件、部署、上传、发布、创建/更新草稿、生成文件/图片、发送消息/API、启动服务、网络探测。
- 文本交付可由正文证明：分析、解释、翻译、改写、整理、贴全文。
- 研究/核验若仍是初步总结、单一来源，或 assistant 明确留下重要可自行查证线索，返回 continue；只是可选深入则 finish。
- 用户明确要求后续选项时，菜单式收尾可 finish。

输出格式，reason 不超过 30 个中文字符：
{"action":"finish|continue|block","reason":"..."}
</instruction>`

export function parseTaskClosurePromptBenchmarkArgs(
  args: string[],
): TaskClosurePromptBenchmarkOptions {
  const options: TaskClosurePromptBenchmarkOptions = {
    logsDir: '.zero/logs',
    outDir: DEFAULT_OUT_DIR,
    all: false,
    limit: 120,
    reps: 1,
    concurrency: 3,
    model: 'deepseek-v4-flash',
    secretSource: 'vault',
    maxTokens: 800,
    dryRun: false,
    resume: false,
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const next = () => args[++index]
    if (arg === '--logs') {
      options.logsDir = next()
    } else if (arg === '--out') {
      options.outDir = next()
    } else if (arg === '--sessions') {
      options.sessionIds = splitCsv(next())
    } else if (arg === '--variants') {
      options.variants = splitCsv(next())
    } else if (arg === '--labels') {
      options.labels = parseBenchmarkLabels(next())
    } else if (arg === '--all') {
      options.all = true
    } else if (arg === '--limit') {
      options.limit = Number.parseInt(next(), 10)
    } else if (arg === '--reps') {
      options.reps = Number.parseInt(next(), 10)
    } else if (arg === '--concurrency') {
      options.concurrency = Number.parseInt(next(), 10)
    } else if (arg === '--model') {
      options.model = next()
    } else if (arg === '--secret-source') {
      const value = next()
      if (value === 'vault' || value === 'env') options.secretSource = value
    } else if (arg === '--resolve-host') {
      options.resolveHost = next()
    } else if (arg === '--max-tokens') {
      options.maxTokens = Number.parseInt(next(), 10)
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--resume') {
      options.resume = true
    } else if (arg === '--help' || arg === '-h') {
      printTaskClosurePromptBenchmarkHelp()
      process.exit(0)
    }
  }

  return options
}

export function printTaskClosurePromptBenchmarkHelp(): void {
  console.log(`Usage: bun run task-closure:prompt-bench [options]

Options:
  --logs <dir>              logs root containing sessions/*/*/trace.jsonl (default .zero/logs)
  --out <dir>               output directory
  --sessions <ids>          comma-separated session ids
  --labels <labels>         comma-separated finish,continue,block,failed
  --variants <ids>          comma-separated variant ids
  --limit <n>               stratified sample count unless --all is set (default 120)
  --all                     run every extracted task closure sample
  --reps <n>                runs per sample/variant (default 1)
  --concurrency <n>         concurrent API calls (default 3)
  --model <id>              official DeepSeek model id (default deepseek-v4-flash)
  --secret-source <vault|env>  read deepseek_api_key from vault or env (default vault)
  --resolve-host <ip>       bypass system DNS for api.deepseek.com with a resolved IP
  --max-tokens <n>          max output tokens per call (default 800)
  --dry-run                 extract samples and write report without API calls
  --resume                  reuse successful rows in out/runs.jsonl and retry request errors
`)
}

export async function runTaskClosurePromptBenchmark(
  options: TaskClosurePromptBenchmarkOptions,
): Promise<TaskClosurePromptBenchmarkReport> {
  const variants = selectVariants(options.variants)
  const { samples: allSamples, inventory: baseInventory } = loadTaskClosureSamples(options)
  const samples = selectSamples(allSamples, options)
  const inventory: TaskClosureInventory = {
    ...baseInventory,
    selectedActionCounts: countSampleActions(samples),
  }

  mkdirSync(options.outDir, { recursive: true })
  writeFileSync(
    join(options.outDir, 'samples.json'),
    JSON.stringify(redactSamples(samples), null, 2),
  )
  writeFileSync(join(options.outDir, 'prompt-variants.md'), renderPromptVariants(variants))

  let results: TaskClosurePromptRunResult[] = []
  if (!options.dryRun) {
    const adapter = await createDeepSeekAdapter(options)
    const resultsPath = join(options.outDir, 'runs.jsonl')
    const existingResults = options.resume
      ? readExistingResults(resultsPath).filter((result) => !result.error)
      : []
    const completedKeys = new Set(existingResults.map(resultKey))
    writeFileSync(
      resultsPath,
      existingResults.length > 0
        ? `${existingResults.map((result) => JSON.stringify(result)).join('\n')}\n`
        : '',
      'utf-8',
    )

    const tasks: Array<() => Promise<TaskClosurePromptRunResult>> = []
    for (const sample of samples) {
      for (const variant of variants) {
        for (let rep = 1; rep <= Math.max(1, options.reps); rep++) {
          if (completedKeys.has(resultKey({ sample, variant, rep }))) continue
          tasks.push(() => runPromptVariant({ sample, variant, rep, adapter, options }))
        }
      }
    }

    const newResults = await runWithConcurrency(tasks, options.concurrency, (result) => {
      appendFileSync(resultsPath, `${JSON.stringify(result)}\n`, 'utf-8')
      console.log(
        `[task-closure-prompt] ${result.variantId} rep=${result.rep} sample=${result.sampleId} expected=${result.expectedAction ?? 'unlabeled'} action=${result.action ?? 'parse_fail'} match=${result.matchesHistorical ?? 'n/a'}${result.error ? ` error=${result.error}` : ''}`,
      )
    })
    results = [...existingResults, ...newResults]
  }

  const report: TaskClosurePromptBenchmarkReport = {
    generatedAt: new Date().toISOString(),
    model: options.model,
    logsDir: options.logsDir,
    options: {
      all: options.all,
      limit: options.limit,
      reps: options.reps,
      concurrency: options.concurrency,
      maxTokens: options.maxTokens,
      dryRun: options.dryRun,
      resume: options.resume,
      ...(options.sessionIds ? { sessionIds: options.sessionIds } : {}),
      ...(options.variants ? { variants: options.variants } : {}),
      ...(options.labels ? { labels: options.labels } : {}),
      ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
    },
    inventory,
    variants: variants.map(({ buildPrompt: _buildPrompt, ...variant }) => variant),
    samples: redactSamples(samples),
    summaries: summarizeVariants(variants, results),
    results,
  }

  writeFileSync(join(options.outDir, 'summary.json'), JSON.stringify(report, null, 2), 'utf-8')
  writeFileSync(
    join(options.outDir, 'report.md'),
    renderTaskClosurePromptBenchmarkMarkdown(report),
    'utf-8',
  )
  return report
}

async function runPromptVariant(input: {
  sample: TaskClosurePromptSample
  variant: TaskClosurePromptVariant
  rep: number
  adapter: ProviderAdapter
  options: TaskClosurePromptBenchmarkOptions
}): Promise<TaskClosurePromptRunResult> {
  const { sample, variant, rep, adapter, options } = input
  const prompt = sanitizeForJsonTransport(variant.buildPrompt(sample.fields))
  const startedAt = Date.now()

  try {
    const response = await completeWithRetry(
      adapter,
      {
        messages: [classifierMessage(sample.sessionId, prompt)],
        system: TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT,
        stream: false,
        maxTokens: options.maxTokens,
        reasoningEffort: 'low',
        meta: {
          sessionId: sample.sessionId,
          purpose: 'task_closure',
        },
      },
      1,
    )
    const text = extractAssistantText(response.content)
    const parsed = parseTaskClosureDecision(text)
    const matchesHistorical =
      sample.expectedAction && parsed ? sample.expectedAction === parsed.action : undefined

    return {
      variantId: variant.id,
      variantTitle: variant.title,
      rep,
      sampleId: sample.id,
      sessionId: sample.sessionId,
      expectedAction: sample.expectedAction,
      historicalEvent: sample.historicalEvent,
      parseOk: Boolean(parsed),
      action: parsed?.action,
      reason: parsed?.reason,
      matchesHistorical,
      model: response.model,
      inputTokens: response.usage?.input ?? 0,
      outputTokens: response.usage?.output ?? 0,
      durationMs: Date.now() - startedAt,
      promptChars: prompt.length,
      responseChars: text.length,
      ...(!parsed ? { responsePreview: previewText(text || response.reasoningContent || '') } : {}),
    }
  } catch (error) {
    return {
      variantId: variant.id,
      variantTitle: variant.title,
      rep,
      sampleId: sample.id,
      sessionId: sample.sessionId,
      expectedAction: sample.expectedAction,
      historicalEvent: sample.historicalEvent,
      parseOk: false,
      model: options.model,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - startedAt,
      promptChars: prompt.length,
      responseChars: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function loadTaskClosureSamples(options: TaskClosurePromptBenchmarkOptions): {
  samples: TaskClosurePromptSample[]
  inventory: Omit<TaskClosureInventory, 'selectedActionCounts'>
} {
  const sessionsRoot = join(options.logsDir, 'sessions')
  const traceReads = readTraceFiles(sessionsRoot)
  const closureReads = readClosureFiles(sessionsRoot)
  const sessionFilter = options.sessionIds ? new Set(options.sessionIds) : undefined
  const rawSamples: TaskClosureRawSample[] = []
  let traceTaskClosureEventCount = 0
  let closureTaskClosureEventCount = 0
  let closurePromptCandidateCount = 0

  for (const traceRead of traceReads) {
    for (const entry of collapseTraceEntries(traceRead.entries)) {
      if (entry.kind !== 'closure_decision' && entry.kind !== 'closure_failed') continue
      if (sessionFilter && !sessionFilter.has(entry.sessionId)) continue

      const closure = asRecord(asRecord(entry.data)?.closure)
      if (!closure) continue
      const event = asString(closure.event)
      if (event !== 'task_closure_decision' && event !== 'task_closure_failed') continue
      traceTaskClosureEventCount++
      rawSamples.push({
        source: 'trace',
        sourcePath: traceRead.path,
        sessionId: entry.sessionId,
        spanId: entry.spanId,
        ts: asString(closure.ts) ?? entry.endTime ?? entry.startTime,
        closure,
      })
    }
  }

  for (const closureRead of closureReads) {
    for (const { lineNumber, value: closure } of closureRead.entries) {
      const event = asString(closure.event)
      if (event !== 'task_closure_decision' && event !== 'task_closure_failed') continue

      const sessionId = asString(closure.sessionId)
      if (!sessionId) continue
      if (sessionFilter && !sessionFilter.has(sessionId)) continue

      closureTaskClosureEventCount++
      if (asString(asRecord(closure.classifierRequest)?.prompt)) {
        closurePromptCandidateCount++
      }
      rawSamples.push({
        source: 'closure',
        sourcePath: closureRead.path,
        sessionId,
        spanId:
          asString(closure.spanId) ??
          asString(closure.assistantMessageId) ??
          `closure_${lineNumber}_${hashish(closureRead.path, asString(closure.ts) ?? lineNumber)}`,
        ts: asString(closure.ts) ?? asString(closure.assistantMessageCreatedAt) ?? '',
        closure,
      })
    }
  }

  const samplesById = new Map<string, TaskClosurePromptSample>()
  let skippedPromptCount = 0
  let duplicateSampleCount = 0

  for (const raw of rawSamples) {
    const classifierRequest = asRecord(raw.closure.classifierRequest)
    const prompt = asString(classifierRequest?.prompt)
    if (!prompt) {
      skippedPromptCount++
      continue
    }

    const fields = extractPromptFields(prompt)
    if (!fields) {
      skippedPromptCount++
      continue
    }

    const event = asString(raw.closure.event) as 'task_closure_decision' | 'task_closure_failed'
    const expectedAction = asAction(raw.closure.action)
    const sample: TaskClosurePromptSample = {
      id: `${raw.sessionId}:${raw.spanId}`,
      source: raw.source,
      sessionId: raw.sessionId,
      spanId: raw.spanId,
      sourcePath: raw.sourcePath,
      ts: raw.ts,
      historicalEvent: event,
      expectedAction,
      historicalReason: asString(raw.closure.reason),
      failureStage: asString(raw.closure.failureStage),
      promptChars: prompt.length,
      assistantChars: fields.assistantText.length,
      assistantTailChars: fields.assistantTail.length,
      toolSummaryChars: fields.toolSummary.length,
      hasAppliedQueuedMessages: Boolean(fields.appliedQueuedMessages),
      fields,
    }
    const existing = samplesById.get(sample.id)
    if (existing) {
      duplicateSampleCount++
      if (existing.ts.localeCompare(sample.ts) <= 0) samplesById.set(sample.id, sample)
    } else {
      samplesById.set(sample.id, sample)
    }
  }

  const samples = Array.from(samplesById.values())
  samples.sort((left, right) => left.ts.localeCompare(right.ts))

  return {
    samples,
    inventory: {
      sessionDirectoryCount: countSessionDirectories(sessionsRoot),
      traceFileCount: traceReads.length,
      rawTraceLineCount: traceReads.reduce((sum, item) => sum + item.rawLineCount, 0),
      traceTaskClosureEventCount,
      closureFileCount: closureReads.length,
      rawClosureLineCount: closureReads.reduce((sum, item) => sum + item.rawLineCount, 0),
      closureTaskClosureEventCount,
      closurePromptCandidateCount,
      taskClosureEventCount: rawSamples.length,
      extractedSampleCount: samples.length,
      duplicateSampleCount,
      skippedPromptCount,
      allActionCounts: countSampleActions(samples),
    },
  }
}

function readTraceFiles(root: string): TraceFileRead[] {
  const files: string[] = []
  walkTraceFiles(root, files)
  return files.map((path) => {
    const lines = readFileSync(path, 'utf-8').split('\n')
    const entries: TraceEntry[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line) as TraceEntry)
      } catch {
        // Ignore malformed trace lines; trace projection code follows the same defensive posture.
      }
    }
    return { path, entries, rawLineCount: lines.filter((line) => line.trim()).length }
  })
}

function readClosureFiles(root: string): ClosureFileRead[] {
  const files: string[] = []
  walkClosureFiles(root, files)
  return files.map((path) => {
    const lines = readFileSync(path, 'utf-8').split('\n')
    const entries: ClosureFileEntry[] = []
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (!line.trim()) continue
      try {
        const value = asRecord(JSON.parse(line))
        if (value) entries.push({ lineNumber: index + 1, value })
      } catch {
        // Ignore malformed legacy closure lines; inventory still counts raw non-empty lines.
      }
    }
    return { path, entries, rawLineCount: lines.filter((line) => line.trim()).length }
  })
}

function walkTraceFiles(dir: string, files: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      walkTraceFiles(path, files)
    } else if (name === 'trace.jsonl') {
      files.push(path)
    }
  }
}

function walkClosureFiles(dir: string, files: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      walkClosureFiles(path, files)
    } else if (name === 'closure.jsonl') {
      files.push(path)
    }
  }
}

function countSessionDirectories(root: string): number {
  let count = 0
  for (const dateName of readdirSync(root)) {
    const datePath = join(root, dateName)
    if (!lstatSync(datePath).isDirectory()) continue
    for (const sessionName of readdirSync(datePath)) {
      const sessionPath = join(datePath, sessionName)
      if (lstatSync(sessionPath).isDirectory()) count++
    }
  }
  return count
}

function extractPromptFields(prompt: string): TaskClosurePromptFields | null {
  const userMessage = extractTag(prompt, 'user_message')
  const assistantText = extractTag(prompt, 'assistant_text')
  const assistantTail = extractTag(prompt, 'assistant_tail') ?? tailText(assistantText ?? '')
  if (!userMessage || !assistantText) return null

  return {
    userMessage,
    assistantText,
    assistantTail,
    toolSummary: extractTag(prompt, 'tool_calls_this_turn') ?? 'none',
    appliedQueuedMessages: extractTag(prompt, 'applied_queued_messages'),
  }
}

function extractTag(input: string, tag: string): string | undefined {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = input.indexOf(open)
  if (start < 0) return undefined
  const end = input.indexOf(close, start + open.length)
  if (end < 0) return undefined
  const value = input.slice(start + open.length, end).trim()
  return value.length > 0 ? value : undefined
}

function buildPromptWithInstruction(
  fields: TaskClosurePromptFields,
  instruction: string,
  options: {
    assistantMode:
      | 'full-plus-tail'
      | 'tail-only'
      | 'full-no-tail'
      | 'dedup-body-plus-tail'
      | 'tail-first-dedup-body'
  },
): string {
  return [
    instruction,
    renderToolCalls(fields),
    renderUserMessage(fields),
    renderAppliedQueuedMessages(fields),
    renderAssistant(fields, options.assistantMode),
  ]
    .filter(Boolean)
    .join('\n\n')
}

function renderToolCalls(fields: TaskClosurePromptFields): string {
  return `<tool_calls_this_turn>
${fields.toolSummary || 'none'}
</tool_calls_this_turn>`
}

function renderUserMessage(fields: TaskClosurePromptFields): string {
  return `<user_message>
${fields.userMessage}
</user_message>`
}

function renderAppliedQueuedMessages(fields: TaskClosurePromptFields): string {
  if (!fields.appliedQueuedMessages) return ''
  return `<applied_queued_messages>
${fields.appliedQueuedMessages}
</applied_queued_messages>`
}

function renderAssistant(
  fields: TaskClosurePromptFields,
  mode:
    | 'full-plus-tail'
    | 'tail-only'
    | 'full-no-tail'
    | 'dedup-body-plus-tail'
    | 'tail-first-dedup-body',
): string {
  if (mode === 'tail-only') {
    return `<assistant_tail>
${fields.assistantTail}
</assistant_tail>`
  }

  if (mode === 'full-no-tail') {
    return `<assistant_text>
${fields.assistantText}
</assistant_text>`
  }

  if (mode === 'dedup-body-plus-tail') {
    return `<assistant_body_without_tail>
${assistantBodyWithoutTail(fields)}
</assistant_body_without_tail>

<assistant_tail>
${fields.assistantTail}
</assistant_tail>`
  }

  if (mode === 'tail-first-dedup-body') {
    return `<assistant_tail>
${fields.assistantTail}
</assistant_tail>

<assistant_body_without_tail>
${assistantBodyWithoutTail(fields)}
</assistant_body_without_tail>`
  }

  return `<assistant_text>
${fields.assistantText}
</assistant_text>

<assistant_tail>
${fields.assistantTail}
</assistant_tail>`
}

function assistantBodyWithoutTail(fields: TaskClosurePromptFields): string {
  if (!fields.assistantTail || !fields.assistantText.endsWith(fields.assistantTail)) {
    return fields.assistantText
  }
  const body = fields.assistantText.slice(0, -fields.assistantTail.length).trimEnd()
  return body.length > 0 ? body : fields.assistantText
}

function tailText(value: string, maxChars = 1200): string {
  return value.length <= maxChars ? value : value.slice(-maxChars)
}

function classifierMessage(sessionId: string, prompt: string): Message {
  return {
    id: `task_closure_prompt_bench_${hashish(sessionId, prompt.length)}`,
    sessionId,
    role: 'user',
    messageType: 'message',
    content: [{ type: 'text', text: prompt }],
    createdAt: new Date().toISOString(),
  }
}

async function createDeepSeekAdapter(
  options: TaskClosurePromptBenchmarkOptions,
): Promise<ProviderAdapter> {
  const apiKey = await loadDeepSeekApiKey(options)
  if (options.resolveHost) {
    return new DirectDeepSeekAnthropicAdapter(apiKey, options)
  }

  return new AnthropicDeepSeekAdapter({
    providerName: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    auth: { type: 'api_key', apiKeyRef: 'deepseek_api_key' },
    apiKey,
    modelConfig: {
      modelId: options.model,
      maxContext: 1000000,
      maxOutput: options.maxTokens,
      reasoningEffort: 'low',
      capabilities: ['reasoning'],
      tags: ['task-closure', 'benchmark'],
    },
  })
}

class DirectDeepSeekAnthropicAdapter implements ProviderAdapter {
  readonly apiType = 'anthropic-deepseek-direct'

  constructor(
    private readonly apiKey: string,
    private readonly options: TaskClosurePromptBenchmarkOptions,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const payload = JSON.stringify({
      model: req.model ?? this.options.model,
      system: req.system,
      messages: req.messages.map(toAnthropicMessage),
      max_tokens: req.maxTokens ?? this.options.maxTokens,
      thinking: { type: 'enabled' },
      output_config: { effort: req.reasoningEffort ?? 'low' },
    })
    const response = await postJsonViaResolvedHost(
      this.options.resolveHost ?? 'api.deepseek.com',
      this.apiKey,
      payload,
    )
    const body = response as Record<string, unknown>
    const content = parseAnthropicContent(body.content)
    return {
      id: asString(body.id) ?? `msg_${hashish(payload.length, Date.now())}`,
      content,
      stopReason: mapAnthropicStopReason(asString(body.stop_reason)),
      usage: {
        input: asNumber(asRecord(body.usage)?.input_tokens) ?? 0,
        output: asNumber(asRecord(body.usage)?.output_tokens) ?? 0,
        cacheWrite: asNumber(asRecord(body.usage)?.cache_creation_input_tokens),
        cacheRead: asNumber(asRecord(body.usage)?.cache_read_input_tokens),
      },
      model: asString(body.model) ?? this.options.model,
      reasoningContent: content
        .filter(
          (block): block is Extract<ContentBlock, { type: 'thinking' }> =>
            block.type === 'thinking',
        )
        .map((block) => block.thinking)
        .join('\n'),
    }
  }

  stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    throw new Error('stream is not supported by the task closure benchmark direct adapter')
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

async function postJsonViaResolvedHost(
  resolvedHost: string,
  apiKey: string,
  payload: string,
): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'zero-task-closure-deepseek-'))
  const payloadPath = join(dir, 'payload.json')
  writeFileSync(payloadPath, payload, 'utf-8')
  try {
    const curlConfig = [
      `url = ${quoteCurlConfig('https://api.deepseek.com/anthropic/messages')}`,
      'request = POST',
      'connect-timeout = 30',
      'max-time = 180',
      `resolve = ${quoteCurlConfig(`api.deepseek.com:443:${resolvedHost}`)}`,
      `header = ${quoteCurlConfig('content-type: application/json')}`,
      `header = ${quoteCurlConfig('anthropic-version: 2023-06-01')}`,
      `header = ${quoteCurlConfig(`x-api-key: ${apiKey}`)}`,
      `data-binary = ${quoteCurlConfig(`@${payloadPath}`)}`,
      '',
    ].join('\n')

    const proc = Bun.spawn(
      ['curl', '-sS', '--config', '-', '--write-out', '\n__HTTP_STATUS__:%{http_code}'],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    proc.stdin.write(curlConfig)
    proc.stdin.end()

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) {
      throw new Error(summarizeCurlError(stderr))
    }

    const match = stdout.match(/\n__HTTP_STATUS__:(\d{3})$/)
    const status = match ? Number.parseInt(match[1], 10) : 0
    const text = match ? stdout.slice(0, match.index) : stdout
    if (status >= 400) {
      throw new Error(`DeepSeek HTTP ${status}: ${summarizeHttpError(text)}`)
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('DeepSeek returned non-JSON response')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function quoteCurlConfig(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function toAnthropicMessage(message: Message): { role: 'user' | 'assistant'; content: unknown[] } {
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => ({ type: 'text', text: block.text })),
  }
}

function parseAnthropicContent(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return []
  const blocks: ContentBlock[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record) continue
    if (record.type === 'text') {
      blocks.push({ type: 'text', text: asString(record.text) ?? '' })
    } else if (record.type === 'thinking') {
      blocks.push({
        type: 'thinking',
        thinking: asString(record.thinking) ?? '',
        signature: asString(record.signature),
      })
    }
  }
  return blocks
}

function mapAnthropicStopReason(value: string | undefined): CompletionResponse['stopReason'] {
  if (value === 'tool_use') return 'tool_use'
  if (value === 'max_tokens') return 'max_tokens'
  return 'end_turn'
}

function summarizeHttpError(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const error = asRecord(parsed.error)
    return asString(error?.message) ?? asString(parsed.message) ?? text.slice(0, 160)
  } catch {
    return text.slice(0, 160)
  }
}

function summarizeCurlError(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed.slice(0, 240) : 'curl request failed'
}

async function loadDeepSeekApiKey(options: TaskClosurePromptBenchmarkOptions): Promise<string> {
  if (options.secretSource === 'env') {
    const value =
      process.env.ZERO_BENCH_SECRET_DEEPSEEK_API_KEY ??
      process.env.deepseek_api_key ??
      process.env.DEEPSEEK_API_KEY
    if (!value) throw new Error('Missing deepseek_api_key in env')
    return value
  }
  const vault = new Vault(await getMasterKey(), join(process.cwd(), '.zero', 'secrets.enc'))
  vault.load()
  const value = vault.get('deepseek_api_key')?.trim()
  if (!value) throw new Error('Missing deepseek_api_key in vault')
  return value
}

async function completeWithRetry(
  adapter: ProviderAdapter,
  request: Parameters<ProviderAdapter['complete']>[0],
  retries: number,
) {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await adapter.complete(request)
    } catch (error) {
      lastError = error
      if (attempt < retries) await delay(1000 * (attempt + 1))
    }
  }
  throw lastError
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onResult: (result: T) => void,
): Promise<T[]> {
  const results: T[] = []
  let nextIndex = 0
  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++
      const result = await tasks[index]()
      results[index] = result
      onResult(result)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return results
}

function readExistingResults(path: string): TaskClosurePromptRunResult[] {
  if (!existsSync(path)) return []

  const results: TaskClosurePromptRunResult[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as TaskClosurePromptRunResult
      if (parsed.variantId && parsed.sampleId && Number.isFinite(parsed.rep)) {
        results.push(parsed)
      }
    } catch {
      // Ignore partial lines from interrupted long runs.
    }
  }
  return results
}

function resultKey(
  input:
    | TaskClosurePromptRunResult
    | { sample: TaskClosurePromptSample; variant: TaskClosurePromptVariant; rep: number },
): string {
  if ('sample' in input) return `${input.variant.id}\t${input.rep}\t${input.sample.id}`
  return `${input.variantId}\t${input.rep}\t${input.sampleId}`
}

function selectSamples(
  samples: TaskClosurePromptSample[],
  options: TaskClosurePromptBenchmarkOptions,
): TaskClosurePromptSample[] {
  const labels = options.labels ? new Set(options.labels) : undefined
  const filtered = labels
    ? samples.filter((sample) => labels.has(sample.expectedAction ?? 'failed'))
    : samples
  if (options.all || options.limit <= 0 || filtered.length <= options.limit) return filtered

  const buckets = new Map<string, TaskClosurePromptSample[]>()
  for (const sample of filtered) {
    const key = sample.expectedAction ?? 'failed'
    const bucket = buckets.get(key)
    if (bucket) bucket.push(sample)
    else buckets.set(key, [sample])
  }

  const keys = ['block', 'continue', 'finish', 'failed'].filter((key) => buckets.has(key))
  const baseQuota = Math.floor(options.limit / keys.length)
  let remainder = options.limit % keys.length
  const selected: TaskClosurePromptSample[] = []
  for (const key of keys) {
    const quota = baseQuota + (remainder > 0 ? 1 : 0)
    remainder = Math.max(0, remainder - 1)
    selected.push(...selectEvenly(buckets.get(key) ?? [], quota))
  }
  return selected.sort((left, right) => left.ts.localeCompare(right.ts))
}

function selectEvenly<T>(items: T[], count: number): T[] {
  if (count <= 0) return []
  if (items.length <= count) return items
  if (count === 1) return [items[0]]

  const selected: T[] = []
  const lastIndex = items.length - 1
  for (let index = 0; index < count; index++) {
    selected.push(items[Math.round((index * lastIndex) / (count - 1))])
  }
  return selected
}

function selectVariants(ids: string[] | undefined): TaskClosurePromptVariant[] {
  if (!ids || ids.length === 0) return TASK_CLOSURE_PROMPT_VARIANTS
  const wanted = new Set(ids)
  const variants = TASK_CLOSURE_PROMPT_VARIANTS.filter((variant) => wanted.has(variant.id))
  const known = new Set(TASK_CLOSURE_PROMPT_VARIANTS.map((variant) => variant.id))
  const unknown = ids.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    throw new Error(`Unknown prompt variant(s): ${unknown.join(', ')}`)
  }
  return variants
}

function summarizeVariants(
  variants: TaskClosurePromptVariant[],
  results: TaskClosurePromptRunResult[],
): TaskClosurePromptVariantSummary[] {
  return variants.map((variant) => {
    const rows = results.filter((result) => result.variantId === variant.id)
    const parsedRows = rows.filter((result) => result.parseOk)
    const errorRows = rows.filter((result) => result.error)
    const parseFailRows = rows.filter((result) => !result.parseOk && !result.error)
    const labeledRows = rows.filter((result) => result.expectedAction)
    const matchedRows = labeledRows.filter((result) => result.matchesHistorical)
    return {
      variantId: variant.id,
      title: variant.title,
      hypothesis: variant.hypothesis,
      runCount: rows.length,
      requestErrorCount: errorRows.length,
      parseFailCount: parseFailRows.length,
      parseRate: percent(parsedRows.length, rows.length),
      labeledRunCount: labeledRows.length,
      historicalMatchRate:
        labeledRows.length > 0 ? percent(matchedRows.length, labeledRows.length) : null,
      blockRecall: actionRecall(rows, 'block'),
      continueRecall: actionRecall(rows, 'continue'),
      finishRecall: actionRecall(rows, 'finish'),
      avgInputTokens: average(rows.map((row) => row.inputTokens)),
      avgOutputTokens: average(rows.map((row) => row.outputTokens)),
      avgDurationMs: average(rows.map((row) => row.durationMs)),
      predictedActionCounts: countResultsByAction(rows),
      confusionMatrix: buildConfusionMatrix(rows),
    }
  })
}

function actionRecall(
  rows: TaskClosurePromptRunResult[],
  action: TaskClosureAction,
): number | null {
  const expected = rows.filter((row) => row.expectedAction === action)
  if (expected.length === 0) return null
  return percent(expected.filter((row) => row.action === action).length, expected.length)
}

function buildConfusionMatrix(
  rows: TaskClosurePromptRunResult[],
): Record<TaskClosureAction, Record<string, number>> {
  return {
    block: countPredictions(rows, 'block'),
    continue: countPredictions(rows, 'continue'),
    finish: countPredictions(rows, 'finish'),
  }
}

function countPredictions(
  rows: TaskClosurePromptRunResult[],
  expectedAction: TaskClosureAction,
): Record<string, number> {
  const counts: Record<string, number> = { block: 0, continue: 0, finish: 0, parse_fail: 0 }
  for (const row of rows) {
    if (row.expectedAction !== expectedAction) continue
    counts[row.action ?? 'parse_fail'] = (counts[row.action ?? 'parse_fail'] ?? 0) + 1
  }
  return counts
}

function countResultsByAction(rows: TaskClosurePromptRunResult[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const key = row.action ?? 'parse_fail'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function countSampleActions(samples: TaskClosurePromptSample[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const sample of samples) {
    const key = sample.expectedAction ?? 'failed'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function renderPromptVariants(variants: TaskClosurePromptVariant[]): string {
  return [
    '# Task Closure Prompt Variants',
    '',
    ...variants.flatMap((variant) => [
      `## ${variant.id}: ${variant.title}`,
      '',
      variant.hypothesis,
      '',
    ]),
  ].join('\n')
}

export function renderTaskClosurePromptBenchmarkMarkdown(
  report: TaskClosurePromptBenchmarkReport,
): string {
  const lines = [
    '# Task Closure Prompt Benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    `Model: ${report.model}`,
    `Logs: ${report.logsDir}`,
    '',
    '## Inventory',
    '',
    `- Session directories: ${report.inventory.sessionDirectoryCount}`,
    `- Trace files: ${report.inventory.traceFileCount}`,
    `- Raw trace lines: ${report.inventory.rawTraceLineCount}`,
    `- Trace task closure events: ${report.inventory.traceTaskClosureEventCount}`,
    `- Closure files: ${report.inventory.closureFileCount}`,
    `- Raw closure lines: ${report.inventory.rawClosureLineCount}`,
    `- Closure task closure events: ${report.inventory.closureTaskClosureEventCount}`,
    `- Closure prompt candidates: ${report.inventory.closurePromptCandidateCount}`,
    `- Task closure candidates: ${report.inventory.taskClosureEventCount}`,
    `- Extracted unique samples: ${report.inventory.extractedSampleCount}`,
    `- Selected samples: ${report.samples.length}`,
    `- Duplicate samples collapsed: ${report.inventory.duplicateSampleCount}`,
    `- Skipped prompts: ${report.inventory.skippedPromptCount}`,
    `- All action counts: ${formatCounts(report.inventory.allActionCounts)}`,
    `- Selected action counts: ${formatCounts(report.inventory.selectedActionCounts)}`,
    '',
    'Historical actions are weak labels from prior task-closure decisions, not manually audited truth.',
    '',
    '## Summaries',
    '',
    '| Variant | Runs | Request errors | Parse fails | Parse | Match | Block recall | Continue recall | Finish recall | Avg input | Avg output |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.summaries.map(
      (summary) =>
        `| ${summary.variantId} | ${summary.runCount} | ${summary.requestErrorCount} | ${summary.parseFailCount} | ${formatPercent(summary.parseRate)} | ${formatMaybePercent(summary.historicalMatchRate)} | ${formatMaybePercent(summary.blockRecall)} | ${formatMaybePercent(summary.continueRecall)} | ${formatMaybePercent(summary.finishRecall)} | ${summary.avgInputTokens.toFixed(0)} | ${summary.avgOutputTokens.toFixed(0)} |`,
    ),
    '',
    '## Confusion Matrices',
    '',
    ...report.summaries.flatMap((summary) => [
      `### ${summary.variantId}`,
      '',
      '| Expected | Pred block | Pred continue | Pred finish | Parse fail |',
      '| --- | ---: | ---: | ---: | ---: |',
      ...(['block', 'continue', 'finish'] as const).map((action) => {
        const row = summary.confusionMatrix[action]
        return `| ${action} | ${row.block ?? 0} | ${row.continue ?? 0} | ${row.finish ?? 0} | ${row.parse_fail ?? 0} |`
      }),
      '',
      `Predicted action counts: ${formatCounts(summary.predictedActionCounts)}`,
      '',
    ]),
  ]
  return lines.join('\n')
}

function redactSamples(samples: TaskClosurePromptSample[]) {
  return samples.map(({ fields: _fields, ...sample }) => sample)
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseBenchmarkLabels(value: string | undefined): Array<TaskClosureAction | 'failed'> {
  const labels = splitCsv(value)
  const unknown = labels.filter((label) => !isBenchmarkLabel(label))
  if (unknown.length > 0) {
    throw new Error(`Unknown benchmark label(s): ${unknown.join(', ')}`)
  }
  return labels as Array<TaskClosureAction | 'failed'>
}

function isBenchmarkLabel(value: string): value is TaskClosureAction | 'failed' {
  return value === 'finish' || value === 'continue' || value === 'block' || value === 'failed'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asAction(value: unknown): TaskClosureAction | undefined {
  return value === 'finish' || value === 'continue' || value === 'block' ? value : undefined
}

function percent(count: number, total: number): number {
  return total > 0 ? roundOne((count / total) * 100) : 0
}

function average(values: number[]): number {
  const valid = values.filter((value) => Number.isFinite(value))
  if (valid.length === 0) return 0
  return roundOne(valid.reduce((sum, value) => sum + value, 0) / valid.length)
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10
}

function formatMaybePercent(value: number | null): string {
  return value === null ? 'n/a' : formatPercent(value)
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  return entries.length > 0 ? entries.map(([key, value]) => `${key}=${value}`).join(', ') : 'none'
}

function previewText(value: string, maxChars = 500): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars)}...`
}

function sanitizeForJsonTransport(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1]
        index++
      } else {
        output += '\uFFFD'
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += '\uFFFD'
    } else {
      output += value[index]
    }
  }
  return output
}

function hashish(...parts: Array<string | number>): string {
  let hash = 0
  const input = parts.join(':')
  for (let index = 0; index < input.length; index++) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
