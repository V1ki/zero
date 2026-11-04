import type {
  RouterJobReceipt,
  RouterRepositoryPage,
  TriggerConversationTurn,
} from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'

export function repositoryReply(list: RouterRepositoryPage): string {
  if (!list.repositories.length) {
    return list.page === 1
      ? '当前 GitHub 连接没有可见的仓库。'
      : `当前 GitHub 连接的仓库列表第 ${list.page} 页没有结果。`
  }
  return [
    `当前 GitHub 连接可见的仓库（第 ${list.page} 页）：`,
    ...list.repositories.map((name, index) => `${index + 1}. ${name}`),
    ...(list.nextPage === null ? [] : [`可以继续查看第 ${list.nextPage} 页。`]),
  ].join('\n')
}

const jobStates: Record<RouterJobReceipt['status'], string> = {
  queued: '已排队',
  running: '执行中',
  completed: '已完成',
  failed: '执行失败',
  unknown: '执行结果待核对',
}

export function jobReply(job: RouterJobReceipt): string {
  const executor = job.executor === 'codex' ? 'Codex' : 'ZeRo'
  const target = job.repository ? ` · ${job.repository}` : ''
  return `派工 #${job.id}（${executor}${target}）${jobStates[job.status]}。${job.result ? `\n${job.result}` : ''}`
}

const ordinalWords = '一二三四五六七八九'
function ordinalNumber(word: string): number {
  if (/^\d+$/u.test(word)) return Number(word)
  if (word === '两') return 2
  if (word === '十') return 10
  if (word === '二十') return 20
  if (word.startsWith('十') && word.length === 2 && ordinalWords.includes(word[1]))
    return 11 + ordinalWords.indexOf(word[1])
  return word.length === 1 ? ordinalWords.indexOf(word) + 1 : 0
}

/** Resolve references against the exact ordering the user saw, never against a fresh remote list. */
export function resolveJobRepository(
  question: string,
  supplied: unknown,
  displayed?: RouterRepositoryPage,
): string | undefined {
  const fullName = /^[a-z0-9-]+\/[a-z0-9._-]+$/iu
  if (supplied !== undefined && (typeof supplied !== 'string' || !fullName.test(supplied)))
    throw new TriggerAgentError('请提供仓库全名，例如 owner/repository。')
  const names = [
    ...question.matchAll(
      /(?<![a-z0-9./_-])(?:https?:\/\/github\.com\/)?([a-z0-9-]+\/[a-z0-9._-]+)/giu,
    ),
  ].map((match) => match[1])
  const mentioned =
    typeof supplied === 'string' &&
    names.some((name) => name.toLowerCase() === supplied.toLowerCase())
  const ordinals = [
    ...question.matchAll(
      /第\s*([\d一二两三四五六七八九十百]+)\s*(?:个|项|条)(?!\s*(?:文件|问题|任务|步骤|作业|测试|版本|PR|工作流))/giu,
    ),
  ]
  if (ordinals.length && (displayed || /仓库/u.test(question))) {
    const indexes = new Set(ordinals.map((match) => ordinalNumber(match[1])))
    const pinned = displayed?.repositories[ordinalNumber(ordinals[0][1]) - 1]
    if (
      indexes.size !== 1 ||
      !pinned ||
      (supplied && pinned.toLowerCase() !== supplied.toLowerCase())
    )
      throw new TriggerAgentError('无法把这个序号对应到刚才显示的单个仓库，请指定仓库全名。')
    return pinned
  }
  if (supplied && !mentioned)
    throw new TriggerAgentError('请选择用户本轮点名的仓库，或按刚才列表中的序号选择。')
  if (supplied) return supplied
  if (names.length === 1 && /GitHub|仓库|repos?itory/iu.test(question)) return names[0]
  return undefined
}

export function recentWorkAnswer(history: readonly TriggerConversationTurn[]) {
  return history.filter((turn) => turn.status === 'completed' && turn.answer !== null).slice(-8)
}

// This guard authorizes the write-capable executor; the LLM still selects tools and understands tasks.
export function explicitlyRequestsEngineering(question: string): boolean {
  if (
    /不要|不必|别(?:再|去|动|改|写|修|跑)|暂不|如何|怎么(?:做|修|改|跑)|是否|如果|假如|假设|举例|例如|解释|讨论|只读|只(?:想|需|是)?(?:看|分析|研究|检查)|do not|don't|how (?:to|would)|what if|read.only|explain/iu.test(
      question,
    )
  )
    return false
  // Strip attributed text before checking the outer imperative ("summarize: fix..." is not a grant).
  const outer = question.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|`[^`]*`/gu, ' ').trim()
  const imperative =
    /^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|替我|现在|直接|先|再|接着|继续|用\s*Codex|让\s*Codex|Codex|please)\s*)*(?:把|将|在|为|给|修复|修正|修一下|修改|改一下|实现|编写|写|添加|重构|补|跑|运行|\b(?:fix|implement|refactor|patch|edit|write|run)\b)/iu
  const action =
    /修(?:复|好|正|一下)|改(?:动|好|一下|写|成|为|造)|修改|实现|添加|重构|编写|写(?:一个|一段|代码|测试)|补(?:上|齐|测试)|(?:跑|运行).{0,8}(?:测试|构建)|\b(?:fix|implement|refactor|patch|edit|write|run (?:the )?tests?)\b/iu
  return imperative.test(outer) && action.test(outer)
}

export function asksOnlyForProgress(question: string): boolean {
  const progress =
    /(?:进展|进度|状态|结果)\s*(?:如何|怎样|怎么样|呢|[?？]|$)|(?:派工|工单|这个任务|刚才的任务).{0,16}(?:进展|进度|状态)|(?:完[成了]?|做好|跑完)(?:了吗|没有)|\b(?:status|progress)\b/iu
  const instruct =
    /(?:继续|接着|重新|再(?:跑|分析|查)|进一步|然后|并且)|(?:请|帮我|替我)\s*(?:分析|调查|对比|修复|整理)|\b(?:continue|resume|rerun)\b/iu
  return progress.test(question) && !instruct.test(question)
}

export function asksForRepositoryPage(question: string) {
  const inventory =
    /(?:我的|账号|账户|my\s+).{0,30}(?:仓库|repos?)|(?:仓库|repos?).{0,20}(?:列表|清单|有哪些)|(?:列出|列一下|看看|查看|list).{0,25}(?:GitHub.{0,10}仓库|repos?)/iu
  return (
    inventory.test(question) &&
    !/(?:分析|研究|比较|对比|跟踪|持续|派工|修复|修改|再|然后|investigate|analyze|compare|track)/iu.test(
      question,
    )
  )
}

export function authorizeRouterJobSubmission(
  question: string,
  executor: RouterJobReceipt['executor'],
) {
  if (asksOnlyForProgress(question)) throw new TriggerAgentError('查看进展请查询派工状态。')
  if (asksForRepositoryPage(question))
    throw new TriggerAgentError('查看仓库清单请直接查询 GitHub 连接。')
  if (
    /(?:不要|别|不用|不必|暂不|没有要求|未授权)\s*(?:再|实际|真的|去)?\s*(?:派工|分派|派发|创建|启动|执行|交给)|(?:不要|别|不用)(?:把|将).{0,16}交给|do not (?:delegate|start)|don.t (?:delegate|start)/iu.test(
      question,
    )
  )
    throw new TriggerAgentError('本轮用户没有授权创建派工。')
  if (executor === 'codex' && !explicitlyRequestsEngineering(question))
    throw new TriggerAgentError('需要用户在当前消息中明确要求修改代码或运行测试，才能交给 Codex。')
}

/** Continuing a run can re-enter a write-capable checkout. Require a fresh outer request. */
export function authorizeRouterJobContinuation(
  question: string,
  executor?: RouterJobReceipt['executor'],
) {
  const outer = question.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|`[^`]*`/gu, ' ').trim()
  if (
    asksOnlyForProgress(outer) ||
    /不要|不必|别再|先别|暂不|没有要求|不是让|无需|停止|取消|如果|假如|举例|(?:这句|原话|翻译|转述|解释|示例)|do not|don't|example|explain|translate|what if/iu.test(
      outer,
    )
  )
    throw new TriggerAgentError('这条消息没有授权继续执行，可以用派工编号查询进度。')
  const prefix =
    /^(?:(?:请你?|麻烦你?|帮我|替我|先|现在|请把|把|让|给|对|针对|这项|这条|该|原来的|之前的|上次的|刚才的|派工|工作任务|任务|工单|worker|job|[#\d]+|[:：,，、·]|please)\s*)*/iu
  const request = outer.replace(prefix, '')
  const resume =
    /^(?:继续|接着|再(?:次|往下|查|分析|检查|跑|比较|核对|看看)|进一步|补充|补上|追加|换成|改为|增加|resume\b|continue\b|retry\b)/iu.test(
      request,
    )
  const engineering = explicitlyRequestsEngineering(outer)
  if (!resume && !engineering) throw new TriggerAgentError('请说明要继续执行的工作。')
  if (
    executor === 'codex' &&
    !engineering &&
    !/^(?:继续|接着|再次|resume\b|continue\b|retry\b)/iu.test(request)
  )
    throw new TriggerAgentError('请明确要求继续这项 Codex 工程任务或说明需要执行的修改。')
}
