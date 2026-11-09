import type { RouterJob, TriggerStore } from '@zero-os/observe'
import { type TriggerInboxItem, isPublicGithubFact } from '@zero-os/shared'
import {
  GithubReplyError,
  type RouterGithubReplies,
  githubReplySubject,
} from './router-github-reply'

type Store = Pick<TriggerStore, 'getSettings'> & {
  tracking: Pick<TriggerStore['tracking'], 'eventForJob'>
}
type OwnerRequest = (
  event: TriggerInboxItem,
  signal: AbortSignal,
) => Promise<{ instruction: string; closeIssue?: boolean } | null>
type Subject = NonNullable<ReturnType<typeof githubReplySubject>>

/** Only print a service-generated answer and validated same-repository permalinks in public.
 * In particular, a private Router note, external comment text or a model's proposed URL cannot become a post. */
function publicAnswer(job: RouterJob, target: Subject): string | null {
  const work = job.work
  if (!work || work.outcome === 'observed') return null
  const closing = work.steps.find((step) => step.tool === 'close_issue')
  if (closing && target.kind === 'issue') {
    if (!closing.ok || work.outcome !== 'resolved')
      return '未能确认这个 Issue 已关闭，请在 Router 查看本次办理结果。'
    const verified = work.publicFacts?.some(
      (fact) => fact.label === '当前状态' && fact.value === '已关闭',
    )
    if (!verified) return null
    return `已核实 [Issue #${target.number}](${target.url}) 已关闭。`
  }
  if (work.outcome === 'needs_input')
    return work.steps.some((s) => s.tool === 'find_related_issues')
      ? '我还没能核实你说的历史讨论。能补充一个包名、错误信息或关键词，并再 @ 我一下吗？'
      : '我还没能用当前仓库的只读工具核实结果。请补充希望核对的具体事项或可供核查的线索，并再 @ 我一下。'
  if (!work.steps.some((step) => step.ok)) return null
  const prefix = `https://github.com/${target.repository}/`
  const historical = work.steps.some((step) => step.tool === 'find_related_issues' && step.ok)
  const links = new Set<string>()
  for (const source of work.sources) {
    if (!source.url.toLowerCase().startsWith(prefix.toLowerCase())) continue
    const path = source.url.slice(prefix.length)
    const thread = /^(issues|pull)\/([1-9]\d*)(#issuecomment-[1-9]\d*)?$/.exec(path)
    const run = /^actions\/runs\/([1-9]\d*)(?:\/attempts\/[1-9]\d*)?(?:\/job\/[1-9]\d*)?$/.exec(
      path,
    )
    if (thread && thread[0] === path) {
      if (historical && (thread[1] !== 'issues' || Number(thread[2]) === target.number)) continue
      links.add(
        `[${thread[1] === 'issues' ? 'Issue' : 'PR'} #${thread[2]}${thread[3] ? ' 的原评论' : ''}](${prefix}${path})`,
      )
    } else if (!historical && run && run[0] === path) {
      links.add(`[GitHub Actions 运行 #${run[1]}](${prefix}${path})`)
    }
    if (links.size === 5) break
  }
  if (!links.size) return null
  const citations = [...links].join('、')
  if (historical) return `查到了可核对的历史讨论：${citations}。`
  const subject = `${target.kind === 'issue' ? 'Issue' : 'PR'} #${target.number}`
  const facts = work.steps.some((s) => s.ok && s.tool === 'inspect_github')
    ? work.publicFacts
        ?.filter(isPublicGithubFact)
        .slice(0, 2)
        .map((f) =>
          f.label === '当前状态' ? `${subject} 当前状态：${f.value}。` : `原评论时间：${f.value}。`,
        )
    : undefined
  if (!facts?.length)
    return `目前仅核对了源记录：${citations}。现有信息不足以给出可公开核实的结论；请补充希望我具体核对的事项。`
  return `${facts.join(' ')} 来源：${citations}。`
}

/** Null delegates normal delivery to the Router. Never replays previous comments after opt-in. */
export function createGithubWorkDelivery(
  store: Store,
  replies: Pick<RouterGithubReplies, 'sendWork'>,
  ownerRequest: OwnerRequest,
  authorized: (job: RouterJob) => boolean,
) {
  return async (
    job: RouterJob,
    signal: AbortSignal,
  ): Promise<null | 'delivered' | 'unknown' | 'unavailable'> => {
    if (
      job.kind !== 'github-watch' ||
      job.scope !== 'general' ||
      job.executor !== 'zero' ||
      job.status !== 'completed' ||
      job.workOrigin === 'manual' ||
      !job.work ||
      job.work.outcome === 'observed' ||
      !authorized(job)
    )
      return null
    function binding() {
      if (signal.aborted || !authorized(job)) return null
      const match = store.tracking.eventForJob(job.id, job.attempt)
      if (
        !match?.active ||
        (job.attempt !== 1 &&
          job.workOrigin !== 'owner' &&
          !('followup' in match && match.followup === true)) ||
        !match.event.githubCommentKind ||
        match.event.scope.toLowerCase() !== job.repository?.toLowerCase()
      )
        return null
      const { event } = match
      const repos = store.getSettings().settings.github.repositories
      const target = githubReplySubject(event, repos)
      if (!target) return null
      const repo = repos.find((r) => r.name === target.repository)
      const since = repo?.ownerMentionRepliesSince
      if (
        !repo?.ownerMentionReplies ||
        !since ||
        !(Date.parse(event.occurredAt) > Date.parse(since)) ||
        !(target.kind === 'issue' ? repo.issueComments : repo.pullRequestComments)
      )
        return null
      return { event, target, since }
    }
    const b = binding()
    if (!b) return null
    const { event, target, since } = b
    const body = publicAnswer(job, target)
    if (!body) return null
    const current = () => {
      const now = binding()
      return (
        !!now &&
        now.event.id === event.id &&
        now.target.repositoryId === target.repositoryId &&
        now.target.ref === target.ref &&
        now.target.url === target.url &&
        now.since === since
      )
    }
    try {
      // Ordinary, proactively resolved comments belong in the Router. Check
      // for a public-reply request before reserving the one-per-comment receipt.
      const mention = await ownerRequest(event, signal)
      if (!current()) return 'unavailable'
      if (!mention) return null
      await replies.sendWork(event.id, body, target.ref, target.repository, {
        current,
        signal,
        verify: async (stop) => {
          if (!current()) return false
          const owner = await ownerRequest(event, stop)
          if (!owner || !current()) return false
          if (job.workOrigin === 'owner' && owner.instruction !== job.instruction) return false
          return !job.work?.steps.some((s) => s.tool === 'close_issue') || owner.closeIssue === true
        },
      })
      return 'delivered'
    } catch (error) {
      return error instanceof GithubReplyError && error.unknown ? 'unknown' : 'unavailable'
    }
  }
}
