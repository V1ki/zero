import type { RouterRepositoryTrackingReceipt, TriggerConversationTurn } from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import { focusedRepository, repositoryReferences, resolveJobRepository } from './router-work-reply'

export type RouterTrackingSelection = Pick<
  RouterRepositoryTrackingReceipt,
  'repository' | 'issues' | 'pullRequests' | 'issueComments' | 'pullRequestComments'
>

const imperative =
  /^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|替我|为我|给我|我想(?:让你|要)?|我要(?:你)?|现在|开始|持续|仅|只|please)\s*)*(?:跟踪|追踪|监听|订阅|关注|track\b|watch\b|monitor\b|subscribe\s+to\b)\s*(?:一下)?\s*/iu
const enableFor = /^(?:(?:请(?:你)?|帮我|先|现在)\s*)*(?:为|给)\s*(.+?)\s*(?:开启|启用)\s*(.+)$/iu
const addToTracking =
  /^(?:(?:请(?:你)?|帮我|先|那就)\s*)*(?:把|将)\s*(.+?)\s*(?:也|都)?加(?:入|到)(?:跟踪|监听|订阅)(?:里|中|列表)?$/iu
const kind = '(?:issues?|prs?|pull[ -]+requests?|议题|拉取请求|合并请求)'
const separator = String.raw`(?:以及|和|与|跟|及|、|，|,|/|&|\+|and\b)`
const kinds = new RegExp(
  `(?<![a-z0-9._/:-])${kind}(?:(?:\\s*${separator}\\s*|\\s+)${kind})*(?![a-z0-9._/-])`,
  'iu',
)
const join = new RegExp(`^\\s*${separator}\\s*`, 'iu')
const facet =
  /^(?:(?:下(?:面)?|里(?:面)?|中)?的\s*)?(?:所有|全部|all\s+)?\s*(?:(?<comments>(?:(?:新(?:增|发表|发布|建)?的?|普通|new\s+|ordinary\s+|conversation\s+)\s*)*(?:评论|留言|comments?\b))|(?<states>状态变化|生命周期变化|生命周期|状态变更|状态|变化|变更|动态|lifecycle(?:\s+changes?)?\b|status(?:\s+changes?)?\b|updates?\b|changes?\b))/iu
// These fixed suffixes describe the existing comment policy and never authorize an action.
const commentPolicySuffix =
  /(?:(?:^|[，,]\s*|\s+)(?:(?:无需|不需要|不用)\s*@(?:提及)?|忽略危险操作|过滤包含危险操作的评论))+$/u
const issueKind = /issues?|议题/iu
const prKind = /prs?|pull[ -]+requests?|拉取请求|合并请求/iu
const fullName = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]+$/iu
const deictic =
  /^(?:(?:刚才|之前|上面|刚刚)(?:提到|提及|说到|查看|看|跟踪|监听)(?:过)?的?\s*)?(?:这(?:一)?个|那(?:一)?个|该|本|这个|那个)?\s*(?:GitHub\s*)?(?:仓库|项目)(?:中|里(?:面)?)?$|^(?:这个|那个|刚才那个|(?:this|that)(?:\s+(?:GitHub\s+)?(?:repo(?:sitory)?|project))?)$/iu

function trackingBody(question: string): string | undefined {
  if (question.length > 2000) return
  const value = question
    .trim()
    .replace(/(?:吧|呀)?[。.!！]?\s*$/u, '')
    .trim()
  const command = imperative.exec(value)
  if (command) return value.slice(command[0].length)
  const enable = enableFor.exec(value)
  if (enable) return `${enable[1]} 的 ${enable[2].replace(/(?:的)?(?:跟踪|监听|订阅)$/u, '')}`
  return addToTracking.exec(value)?.[1]
}

/** Recognize the subscription path separately from authorization to commit its settings. */
export function isRouterTrackingRequest(question: string): boolean {
  const body = trackingBody(question)
  if (!body) return false
  const events = kinds.exec(body)
  if (!events) return false
  // PR mentions and CI failures are configured through the existing mandate flow.
  const legacy =
    /@[a-z\d-]+|@我|(?:评论|讨论)(?:中|里)?(?:提及|提到)|\bmentions?\b|工作流|构建失败|发布失败|\bCI\s+(?:failures?|失败)/iu
  return issueKind.test(events[0]) || !legacy.test(body)
}

function eventSelection(body: string, first: RegExpExecArray) {
  const selection: Omit<RouterTrackingSelection, 'repository'> = {
    issues: false,
    pullRequests: false,
  }
  let group = first[0]
  let rest = body.slice(first.index + group.length).trim()
  for (;;) {
    let states = false
    let comments = false
    let part = facet.exec(rest)
    while (part) {
      states ||= !!part.groups?.states
      comments ||= !!part.groups?.comments
      rest = rest.slice(part[0].length).trim()
      const next = join.exec(rest)
      part = next && facet.exec(rest.slice(next[0].length))
      if (next && part) rest = rest.slice(next[0].length)
    }
    // A qualifier after grouped names applies to the whole group (Issue 和 PR 的评论).
    if (issueKind.test(group)) {
      selection.issues ||= states || !comments
      if (comments) selection.issueComments = true
    }
    if (prKind.test(group)) {
      selection.pullRequests ||= states || !comments
      if (comments) selection.pullRequestComments = true
    }
    const next = join.exec(rest)
    const nextGroup = next && kinds.exec(rest.slice(next[0].length))
    if (!next || nextGroup?.index !== 0) return { selection, rest }
    group = nextGroup[0]
    rest = rest.slice(next[0].length + group.length).trim()
  }
}

function clarifyRepository(): never {
  throw new TriggerAgentError(
    '请指定要跟踪的单个仓库，例如「跟踪 owner/repo 的 Issue 和 PR」，也可以按刚显示的列表说「跟踪第二个仓库的 Issue 和 PR」。',
  )
}

function unsupported(): never {
  throw new TriggerAgentError(
    '请明确要跟踪的仓库和事件范围，可以选择 Issue 或 PR 的状态变化、普通评论。附加筛选和通知条件需要单独指定。',
  )
}

/** Resolve directly from the user's outer instruction. The model never supplies the repository or flags. */
export function resolveRouterTrackingRequest(
  question: string,
  history: readonly TriggerConversationTurn[],
): RouterTrackingSelection {
  if (!isRouterTrackingRequest(question)) return unsupported()
  const body = (trackingBody(question) ?? '')
    .replace(/`([a-z0-9._/-]+)`/giu, '$1')
    .replace(
      new RegExp(`^(?:(?:new|ordinary|all)\\s+)*comments?\\s+on\\s+(${kinds.source})`, 'iu'),
      '$1 comments',
    )
    .trim()
  const events = kinds.exec(body)
  if (!events) return unsupported()
  const left = body
    .slice(0, events.index)
    .trim()
    .replace(/\s*(?:的|中|里|中的|里的)?\s*(?:所有|全部)?$/u, '')
    .trim()
  const { selection: families, rest } = eventSelection(body, events)
  const commentSelection = families.issueComments || families.pullRequestComments
  const tail = commentSelection ? rest.replace(commentPolicySuffix, '').trim() : rest
  const right = tail.replace(/^(?:in|on|of|for)\s+/iu, '').trim()
  if (left && right) return unsupported()
  const target = (left || right)
    .replace(/^(?:GitHub\s+仓库|仓库|repo(?:sitory)?)\s+(?=[a-z0-9])/iu, '')
    .replace(/(?<=[a-z0-9._-])\s*仓库$|\s+repo(?:sitory)?$/iu, '')
    .replace(/^(?:「([^」]+)」|“([^”]+)”)$/u, (_, chinese, quoted) => chinese ?? quoted)
    .trim()
  const refs = repositoryReferences(history)
  const explicit = target.replace(/^https:\/\/github\.com\//iu, '').replace(/\/$/u, '')
  if (fullName.test(explicit) && !/\/(?:\.|\.\.)$/u.test(explicit))
    return { repository: explicit, ...families }
  if (
    /^第\s*[\d一二两三四五六七八九十百]+\s*(?:个|项|条)(?:\s*(?:GitHub\s*)?仓库)?$/iu.test(target)
  ) {
    const page = refs.find((ref) => ref.page)?.page
    const repository = resolveJobRepository(`${target}仓库`, undefined, page)
    if (repository) return { repository, ...families }
    return clarifyRepository()
  }
  if (!target || deictic.test(target)) {
    const repository = focusedRepository(refs)
    if (repository) return { repository, ...families }
    return clarifyRepository()
  }
  if (/^[a-z0-9._-]+$/iu.test(target)) {
    const candidates = refs.flatMap(({ selected, page }) => [
      ...(selected ? [selected] : []),
      ...(page?.repositories ?? []),
    ])
    const unique = new Map(
      candidates
        .filter((repo) => repo.split('/')[1]?.toLowerCase() === target.toLowerCase())
        .map((repo) => [repo.toLowerCase(), repo]),
    )
    if (unique.size === 1) return { repository: [...unique.values()][0], ...families }
    return clarifyRepository()
  }
  return unsupported()
}
