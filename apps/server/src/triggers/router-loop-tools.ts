import {
  type GithubInvestigation,
  type GithubInvestigationAction,
  type MandatePlatform,
  type RouterDirectReminder,
  type ToolDefinition,
  type TriggerConversationAnswer,
  type TriggerPreferenceChange,
  type TriggerRouteDecision,
  getTriggerRouteBot,
  isTriggerRoutePlatform,
  triggerRoutePlatforms,
} from '@zero-os/shared'
import { type CommissionIntent, commissionIntents } from './commission-plan'
import { type AgentDependencies, TriggerAgentError } from './event-agent'
import { InvestigationError } from './investigation'
import { MandateInputError } from './mandate-input'
import type { RouterAgentInput } from './router-agent'
import { DirectReminderUnavailableError } from './routing-runtime'

type PublicDraft = Pick<RouterDirectReminder, 'platform' | 'text' | 'botLabel'>
type SendReceipt = PublicDraft & { status: 'accepted' | 'rejected' | 'unknown'; reason?: string }

export interface RouterTurnActions {
  prepareReminder?(platform: MandatePlatform, text: string): PublicDraft
  sendReminder?(
    platform: MandatePlatform,
    text: string,
    signal: AbortSignal,
    draftTurnId?: number,
  ): Promise<SendReceipt>
  prepareCommission?(
    intent: CommissionIntent,
    signal: AbortSignal,
  ): Promise<Pick<TriggerConversationAnswer, 'text' | 'commission'> | null>
  inspectGithub?(
    action: GithubInvestigationAction,
    signal: AbortSignal,
  ): Promise<GithubInvestigation>
  previewRoute?(): Promise<TriggerRouteDecision>
  onToolStep?(name: string, ok: boolean): void
}

const channelNames: Record<MandatePlatform, RegExp> = {
  weixin: /微信|weixin|wechat/iu,
  dingtalk: /钉钉|dingtalk/iu,
  feishu: /飞书|feishu|lark/iu,
}
const platformParam = { type: 'string', enum: triggerRoutePlatforms }
const textParam = { type: 'string', minLength: 1, maxLength: 2000 }
function reject(message: string): never {
  throw new TriggerAgentError(message)
}

function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  const found = choices.find((option) => option === value)
  return found ?? reject('无效的工具参数，请使用参数列表里的选项。')
}

function textValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 2000 ||
    /\p{Cc}/u.test(value.replace(/[\t\r\n]/g, ''))
  )
    return reject('请提供有效的文字正文。')
  return value.trim()
}

// The LLM can discuss arbitrary prose and stage a draft. The irreversible send tool
// has a narrower contract: the entire outer instruction must address this personal
// channel. Unknown words (a date, condition, quotation about someone else, etc.) fail closed.
const sendVerb = /发送|发|通知|提醒|捎|推送|敲我|戳我|告诉我|\b(?:send|notify|message|ping)\b/iu
const directiveWords =
  /(?:我要你|我想让你|劳烦你?|麻烦你?|请你?|帮我|替我|确认|现在|立即|马上|立刻|直接|原样|原文|通过|使用|选中的|机器人|给本人|给自己|给我|本人|自己|我的|我|把|将|让|用|从|在|上|往|到|这个|那个|这句话|这条|一条|一则|一句|一下|一份|个|条|句|口信|消息|正文|内容|通知|提醒|发送|发出去|发出|发|推送|捎|敲我|戳我|告诉我|短信|说|的是|为|是|please|now|immediately|directly|via|using|through|with|on|my|me|to|send|message|notify|ping|this|text|the|a|bot)/giu
const priorReference =
  /(?:刚才的?|刚刚的?|上面(?:的)?|上一条|上条|这条|那条|这个|这份|那份|草稿|draft|previous|that)/giu
const punctuation = /[\s,，:：.。!！]+/gu

function isDirectInstruction(outer: string, platform: MandatePlatform, draft = false): boolean {
  if (!sendVerb.test(outer)) return false
  const mentioned = triggerRoutePlatforms.filter((p) => channelNames[p].test(outer))
  if (mentioned.length ? mentioned.length !== 1 || mentioned[0] !== platform : !draft) return false
  let words = outer.replace(new RegExp(channelNames[platform].source, 'giu'), ' ')
  if (draft)
    words = words.replace(priorReference, ' ').replace(/(?:#|编号\s*|回合\s*)[1-9]\d*/gu, ' ')
  return words.replace(directiveWords, '').replace(punctuation, '') === ''
}

const noSend = '当前请求无法确认是立即给本人发送指定原文。请先准备草稿或向用户澄清，本轮不发送。'
function authorizeSend(
  input: RouterAgentInput,
  platform: MandatePlatform,
  text: string,
  prior: unknown,
): number | undefined {
  const question = input.question.trim()
  if (prior !== undefined) {
    const old = input.history.find((turn) => turn.id === prior)?.answer?.reminder
    const drafts = input.history.filter((turn) => turn.answer?.reminder?.status === 'draft')
    const named =
      typeof prior === 'number' &&
      new RegExp(`(?:#|编号\\s*|回合\\s*)${prior}(?!\\d)`).test(question)
    const refersToDraft =
      /(?:草稿|刚才|上一条|上条|上面|这条|刚刚|前面|that draft|this draft)/iu.test(question)
    if (
      typeof prior !== 'number' ||
      !Number.isSafeInteger(prior) ||
      old?.status !== 'draft' ||
      old.platform !== platform ||
      old.text !== text ||
      !(named || (refersToDraft && drafts.length === 1 && drafts[0].id === prior)) ||
      !isDirectInstruction(question, platform, true)
    )
      reject(noSend)
    return prior
  }
  const at = question.lastIndexOf(text)
  if (at < 0) return reject(noSend)
  let before = question.slice(0, at)
  let after = question.slice(at + text.length)
  const quotes: Record<string, string> = { '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"' }
  // An explicit content delimiter cannot be smuggled into the model's chosen body
  // together with an addressee or schedule that preceded it.
  const delim = question.search(/(?<!\d)[:：]/u)
  if (delim >= at && !quotes[before.at(-1) ?? '']) return reject(noSend)
  const closing = quotes[before.at(-1) ?? '']
  if (closing && after.startsWith(closing)) {
    before = before.slice(0, -1)
    after = after.slice(1)
  } else {
    const boundary = /[\s：:，,]$|(?:通知我|提醒我|告诉我|戳我|敲我)$/u.test(before)
    if (
      !boundary ||
      !/^[\s。.!！]*$/u.test(after) ||
      /[,，。;；]\s*(?:请|再|然后)?(?:发给|转给|转发给|通知|提醒|发到)(?!我|自己|本人)/u.test(text)
    )
      return reject(noSend)
  }
  if (!isDirectInstruction(`${before} ${after}`, platform)) reject(noSend)
}

function isImmediateRequest(question: string) {
  const q = question.trim()
  const selected = triggerRoutePlatforms.filter((p) => channelNames[p].test(q))
  if (selected.length !== 1) return false
  // This detects unsupported claims about a clear imperative only. It never routes
  // an operation. The model must have actually invoked the tool to release a send.
  for (const cut of q.matchAll(/[\s：:,，「“"]+|(?:通知我|提醒我|告诉我)/gu)) {
    const before = q.slice(0, cut.index) + (cut[0].endsWith('我') ? cut[0] : '')
    if (q.slice(cut.index + cut[0].length).trim() && isDirectInstruction(before, selected[0]))
      return true
  }
  return false
}

export function createRouterToolset(
  input: RouterAgentInput,
  filter: AgentDependencies['secretFilter'],
  context: () => unknown,
) {
  const { actions, task, event } = input
  const { prepareReminder, sendReminder, prepareCommission, inspectGithub, previewRoute } =
    actions ?? {}
  const general = !event && !task
  const bots = input.personalBots ?? []
  let proposal: TriggerPreferenceChange | undefined
  let mutationStarted = false
  let sendRequested = false
  let receiptStatus: SendReceipt['status'] | undefined
  let receiptReason: string | undefined
  let receiptPlatform: MandatePlatform | undefined

  const claim = () => {
    if (mutationStarted) reject('本轮已经尝试过一项操作。请根据现有结果答复，不要重复执行。')
    mutationStarted = true
  }
  type Run = (args: Record<string, unknown>, signal: AbortSignal) => unknown
  const definitions: ToolDefinition[] = []
  const executors = new Map<string, Run>()
  function register(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    execute: Run,
    optional: string[] = [],
  ) {
    const required = Object.keys(properties).filter((key) => !optional.includes(key))
    definitions.push({
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    })
    executors.set(name, (args, signal) => {
      if (
        Object.keys(args).some((key) => !Object.hasOwn(properties, key)) ||
        required.some((key) => !Object.hasOwn(args, key))
      )
        reject('工具参数缺失或包含不支持的字段。')
      return execute(args, signal)
    })
  }
  register(
    'get_routing_context',
    '查看本轮范围内已保存的工作时段、在场偏好、订阅数量，以及所选事件或委托的实际记录。',
    {},
    context,
  )
  if (!task) {
    register(
      'list_notification_bots',
      '查询已接入的机器人，哪个账号已选中、在线，以及是否可发送主动提醒。',
      {},
      () =>
        bots.map((b) => ({
          platform: b.platform,
          name: filter.filter(b.label),
          selected: getTriggerRouteBot(input.settings, b.platform) === b.channelId,
          online: b.online,
          ready: b.ready,
          deliveryState: b.deliveryState,
        })),
    )
    if (previewRoute)
      register(
        'preview_current_route',
        '根据此刻的时段、在场信号和渠道状态试算自动通知的去向及原因。仅查询。',
        {},
        () => previewRoute(),
      )
  }
  if (general && !input.imPlatform) {
    register(
      'prepare_routing_preference',
      '为用户要求更改的一项在场模式、时段去向或离席备选准备确认卡。',
      {
        key: {
          type: 'string',
          enum: ['presence', 'duringWork', 'afterWork', 'offDay', 'awayFallback'],
        },
        value: { type: 'string' },
      },
      ({ key, value }) => {
        let next: TriggerPreferenceChange
        if (key === 'presence')
          next = { key, value: choice(value, ['auto', 'present', 'away'] as const) }
        else if (key === 'awayFallback')
          next = { key, value: choice(value, [...triggerRoutePlatforms, 'defer'] as const) }
        else
          next = {
            key: choice(key, ['duringWork', 'afterWork', 'offDay'] as const),
            value: choice(value, [...triggerRoutePlatforms, 'defer', 'web'] as const),
          }
        if (
          isTriggerRoutePlatform(next.value) &&
          !bots.some(
            (b) =>
              b.platform === next.value &&
              getTriggerRouteBot(input.settings, b.platform) === b.channelId,
          )
        )
          reject('请先在 Router 通知设置中为该平台选择一个机器人。')
        claim()
        proposal = next
        return { status: 'draft', key: next.key, value: next.value }
      },
    )
    register(
      'prepare_bot_selection',
      '为用户明确点名的机器人准备绑定确认卡。name 是用户所写名称或账号，请勿猜测。',
      { platform: platformParam, name: textParam },
      ({ platform, name }) => {
        const p = choice(platform, triggerRoutePlatforms)
        const n = textValue(name).toLowerCase()
        if (!input.question.toLowerCase().includes(n)) reject('请用户明确指定机器人名称。')
        const matches = bots.filter(
          (b) => b.platform === p && [b.channelId, b.label].some((id) => id.toLowerCase() === n),
        )
        if (matches.length !== 1)
          reject(matches.length ? '有多个同名机器人，请指定账号标识。' : '找不到这个机器人。')
        const bot = matches[0]
        claim()
        proposal = { key: 'personalBot', platform: p, value: bot.channelId, label: bot.label }
        return { status: 'draft', platform: p, botLabel: filter.filter(bot.label) }
      },
    )
  }
  if (general) {
    if (prepareReminder)
      register(
        'prepare_personal_reminder',
        '为预览或拟稿准备一次性个人提醒，不实际发送。正文来自用户的要求。',
        { platform: platformParam, text: textParam },
        ({ platform, text }) => {
          const p = choice(platform, triggerRoutePlatforms)
          const body = textValue(text)
          claim()
          const d = prepareReminder(p, body)
          return {
            status: 'draft',
            platform: d.platform,
            text: filter.filter(d.text),
            botLabel: filter.filter(d.botLabel),
          }
        },
      )
    if (sendReminder)
      register(
        'send_personal_reminder',
        '立即通过当前选中的机器人给用户本人发送一条通知。只用于当前用户明确要求立即发送；text 必须是用户指定的原文，不要增删礼貌用词或标点。若用户要发送之前的草稿，请提供该草稿的回合编号和原文。',
        { platform: platformParam, text: textParam, draftTurnId: { type: 'integer', minimum: 1 } },
        async ({ platform, text, draftTurnId }, signal) => {
          const p = choice(platform, triggerRoutePlatforms)
          const body = textValue(text)
          sendRequested = true
          const prior = authorizeSend(input, p, body, draftTurnId)
          claim()
          const receipt = await sendReminder(p, body, signal, prior)
          receiptPlatform = receipt.platform
          receiptStatus = receipt.status
          receiptReason = receipt.reason && filter.filter(receipt.reason)
          return {
            status: receipt.status,
            platform: receipt.platform,
            botLabel: filter.filter(receipt.botLabel),
            text: filter.filter(receipt.text),
            ...(receipt.reason && { reason: filter.filter(receipt.reason) }),
          }
        },
        ['draftTurnId'],
      )
    if (prepareCommission)
      register(
        'prepare_commission',
        '从当前用户的原始请求准备跟踪委托的创建、更改、暂停、恢复或项目规则草案。',
        { intent: { type: 'string', enum: commissionIntents } },
        async ({ intent }, signal) => {
          const op = choice(intent, commissionIntents)
          claim()
          const response = await prepareCommission(op, signal)
          return response?.commission
            ? { status: 'draft', title: filter.filter(response.commission.title) }
            : {
                status: 'needs_information',
                text: filter.filter(response?.text ?? '请说明要跟踪的事情、来源和目的。'),
              }
        },
      )
  }
  if (!task && event?.source === 'github' && inspectGithub)
    register(
      'inspect_github',
      '读取所选 GitHub 事件的作业、PR 详情或对比历史运行。',
      { action: { type: 'string', enum: ['inspect_github', 'compare_runs'] } },
      async ({ action }, signal) => {
        const evidence = await inspectGithub(
          choice(action, ['inspect_github', 'compare_runs'] as const),
          signal,
        )
        return {
          kind: evidence.kind,
          observedAt: evidence.observedAt,
          facts: evidence.facts.slice(0, 20).map((f) => ({
            label: filter.filter(f.label),
            value: filter.filter(f.value).slice(0, 800),
          })),
        }
      },
    )
  return {
    definitions,
    onToolStep: actions?.onToolStep,
    async execute(
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<string> {
      const executor = executors.get(name)
      if (!executor || signal.aborted) reject('此工具在当前范围不可用，或本轮已取消。')
      try {
        return JSON.stringify(await executor(args, signal))
      } catch (error) {
        if (
          error instanceof DirectReminderUnavailableError ||
          error instanceof InvestigationError ||
          error instanceof MandateInputError
        )
          throw new TriggerAgentError(filter.filter(error.message).slice(0, 400))
        throw error
      }
    },
    verifyReply(answer: TriggerConversationAnswer): TriggerConversationAnswer {
      if (!general) return answer
      if (receiptStatus === 'rejected')
        return { text: `本轮没有发送通知。${receiptReason ?? '平台拒绝接收这条通知。'}` }
      if (receiptStatus === 'unknown') return { text: '发送结果待核对，请在机器人私聊中查看。' }
      if (receiptStatus === 'accepted' && receiptPlatform) {
        const labels: Record<MandatePlatform, string> = {
          weixin: '微信',
          feishu: '飞书',
          dingtalk: '钉钉',
        }
        return { text: `${labels[receiptPlatform]}平台已受理。` }
      }
      if (sendRequested || (!mutationStarted && isImmediateRequest(input.question)))
        return { text: '本轮没有发送通知。可以请 Router 准备一份草稿，核对后发送。' }
      return answer
    },
    preference(): TriggerConversationAnswer | undefined {
      return (
        proposal && { text: '请核对卡片中的通知偏好，点击确认后生效。', intent: 'route', proposal }
      )
    },
  }
}
