import type { TriggerInboxItem, TriggerSettingsSnapshot } from '@zero-os/shared'
import type { GithubAppAuth } from './github-app-auth'
import { isUnsafeGithubComment } from './github-comment-safety'
import { requestsCurrentIssueClose } from './github-issue-close-intent'
import { githubReplySubject } from './router-github-reply'

type ReadIdentity = GithubAppAuth & {
  getCommentIdentity(ref: string, repository: string, signal: AbortSignal): Promise<string>
}
type Read = (url: URL, init: RequestInit) => Promise<Response>
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

// Examples, quoted messages and links are not an invocation by the author.
function directText(body: string) {
  const prose = body
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, ' ')
    .replace(/<(blockquote|pre|code)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/giu, ' ')
  let fence = ''
  const lines: string[] = []
  for (const line of prose.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = ''
    } else if (marker) fence = marker[1]
    else if (!/^\s*>|^(?: {4}|\t)/u.test(line)) lines.push(line)
  }
  return lines
    .join('\n')
    .replace(/(`+)[\s\S]*?\1/gu, ' ')
    .replace(/!?\[[^\]\n]*\]\([^\s)]*\)|https?:\/\/\S+/giu, ' ')
    .trim()
}

// Only a direct investigative request bypasses triage. The Worker still receives
// read-only tools; other owner prose is an ordinary signal for the Router to assess.
function isDirectReadRequest(text: string) {
  if (/(?:^|[^\w@])@[\w-]+/u.test(text)) return false
  return /^(?:(?:请你?|麻烦你?|帮我|帮忙|能否|能不能|可以帮我)\s*)+(?:先|再)?(?:查|找|看|核对|核查|排查|调查|研究|分析|检查|审查|评估|验证|对比|比较|梳理|解释)|^(?:查一下|找一下|看一下|看看)|^(?:(?:please|could you|can you)\s+)+(?:check|find|inspect|investigate|review|verify|compare|analy[sz]e|research|explain|look (?:up|into|at))\b/iu.test(
    text,
  )
}

/** External comments become instructions only after GitHub confirms their author and discussion. */
export function createGithubOwnerRequest(
  settings: () => TriggerSettingsSnapshot,
  auth: ReadIdentity,
  filter: (text: string) => string,
  read: Read = fetch,
) {
  return async (
    event: TriggerInboxItem,
    signal: AbortSignal,
    mode: 'mention' | 'read-only' = 'mention',
  ): Promise<{ instruction: string; closeIssue?: true } | null> => {
    const snapshot = settings()
    const { revision } = snapshot
    const repos = snapshot.settings.github.repositories
    const target = githubReplySubject(event, repos)
    const id = /^\d+:comment:([1-9]\d*)$/u.exec(event.eventId)?.[1]
    if (!target || !id) return null
    const repo = repos.find((r) => r.name.toLowerCase() === target.repository.toLowerCase())
    if (
      !(target.kind === 'issue' ? repo?.issueComments : repo?.pullRequestComments || repo?.mention)
    )
      return null
    const { ref, repository, repositoryId } = target
    const allowUnmentioned =
      mode === 'read-only' &&
      (target.kind === 'issue' ? repo?.issueComments : repo?.pullRequestComments)
    // A non-owner name from the adapter saves a network request. The positive
    // path always re-reads GitHub's numeric owner ID and exact comment below.
    const displayedAuthor = /^([a-z\d-]+(?:\[bot\])?)：/iu.exec(event.summary)?.[1]
    if (displayedAuthor && displayedAuthor.toLowerCase() !== repository.split('/')[0].toLowerCase())
      return null
    const stop = AbortSignal.any([signal, AbortSignal.timeout(45_000)])
    const bot = await auth.getCommentIdentity(ref, repository, stop)
    if (!/^[a-z\d-]+\[bot\]$/iu.test(bot)) return null
    // A short complete excerpt can rule out a mention, but can never authorize execution.
    if (
      !allowUnmentioned &&
      event.summary.length < 300 &&
      !event.summary.toLowerCase().includes(`@${bot.slice(0, -5).toLowerCase()}`)
    )
      return null
    const bearer = await auth.getToken(ref, repository, stop)
    const base = `https://api.github.com/repos/${repository}`
    const get = async (path: string) => {
      stop.throwIfAborted()
      const r = await read(new URL(base + path), {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        signal: stop,
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ZeRo-Owner-Request',
        },
      })
      if (r.status === 404 || r.status === 410) {
        await r.body?.cancel()
        return null
      }
      if (!r.ok) {
        await r.body?.cancel()
        throw new Error(`无法向 GitHub 核对评论作者（HTTP ${r.status}）。`)
      }
      const v: unknown = await r.json()
      if (!record(v)) throw new Error('GitHub 返回了无效的作者记录。')
      return v
    }
    const [info, comment] = await Promise.all([get(''), get(`/issues/comments/${id}`)])
    if (settings().revision !== revision) throw new Error('仓库监听配置在核验期间已更改。')
    if (
      !info ||
      !comment ||
      info.id !== repositoryId ||
      typeof info.full_name !== 'string' ||
      info.full_name.toLowerCase() !== repository.toLowerCase() ||
      !record(info.owner) ||
      info.owner.type !== 'User' ||
      !Number.isSafeInteger(info.owner.id) ||
      typeof info.owner.login !== 'string' ||
      info.owner.login.toLowerCase() !== repository.split('/')[0].toLowerCase() ||
      !record(comment.user) ||
      comment.user.type !== 'User' ||
      comment.user.id !== info.owner.id ||
      comment.user.login !== info.owner.login ||
      comment.author_association !== 'OWNER' ||
      comment.id !== Number(id) ||
      typeof comment.issue_url !== 'string' ||
      comment.issue_url.toLowerCase() !== `${base}/issues/${target.number}`.toLowerCase() ||
      typeof comment.html_url !== 'string' ||
      comment.html_url.toLowerCase() !== event.url?.toLowerCase() ||
      typeof comment.created_at !== 'string' ||
      Date.parse(comment.created_at) !== Date.parse(event.occurredAt) ||
      comment.updated_at !== comment.created_at ||
      typeof comment.body !== 'string' ||
      isUnsafeGithubComment(comment.body)
    )
      return null
    const plain = directText(comment.body)
    const mention = new RegExp(
      `(?<![a-z0-9_@./-])@${bot.slice(0, -5)}(?:\\[bot\\])?(?![a-z0-9_\\[/-])`,
      'igu',
    )
    const addressed = mention.test(plain)
    if (!addressed && !(allowUnmentioned && isDirectReadRequest(plain))) return null
    const instruction = filter(plain.replace(mention, ' ').trim()).trim()
    if (instruction.length > 4000)
      throw new Error('仓主请求超过单次可处理长度，请在原讨论拆分任务。')
    // The prose extractor intentionally drops quoted text and links. Never derive
    // permission to write from the resulting shortened read-only instruction.
    const explicitClose =
      addressed && requestsCurrentIssueClose(comment.body.replace(mention, ' ').trim(), event)
    return instruction ? { instruction, ...(explicitClose && { closeIssue: true as const }) } : null
  }
}
