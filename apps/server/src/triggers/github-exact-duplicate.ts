import { isUnsafeGithubComment } from './github-comment-safety'

type Row = Record<string, unknown>
const row = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const time = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : Number.NaN)

// Only harmless transport formatting is ignored. Versions, timestamps, paths, switches,
// prose, punctuation and capitalization are part of the identity of a report.
const normalizeBody = (v: string) => v.replace(/\r\n/gu, '\n').replace(/\n$/u, '')
const regression =
  /\b(?:regression|regressed|reopened|reappeared|happening again|still (?:broken|fails?))\b|回归|复发|再次出现|仍(?:然)?(?:出现|失败|报错)/iu
const keepOpen =
  /\b(?:not a duplicate|(?:keep|leave) (?:this (?:issue )?|it )?open|do not close|don['’]t close|different (?:cause|failure)|not the same (?:bug|issue))\b|(?:别|不要|暂不|先不)(?:自动)?关(?:闭)?|(?:并非|不是)(?:重复|同一)|不同(?:的)?原因/iu
const placeholder =
  /<!--|\{\{|\[insert |\b(?:placeholder|lorem ipsum|example trace|sample stack)\b|请在此填写|示例堆栈/iu

export const disputesDuplicate = (text: string) => regression.test(text) || keepOpen.test(text)

function distinctive(body: string) {
  if (body.length < 180 || body.length > 24_000 || placeholder.test(body)) return false
  if (!/\b(?:[\w.]*Error|[\w.]*Exception|panic|fatal)\b[^\n]{4,180}/iu.test(body)) return false
  // A standard error message and a pasted OS/tool version do not identify an incident.
  const frames = new Set<string>()
  for (const line of body.split('\n')) {
    if (/(?:node:internal|node_modules\/|\/vendor\/)/iu.test(line)) continue
    const m =
      line.match(
        /(?:\bat\s+[^\n]*?|^\s*)([\w.@/-]+\.(?:[cm]?[jt]sx?|tsx?|go|rs|java|kt|swift|cpp|cs|rb)):(\d+)(?::\d+)?\b/iu,
      ) ?? line.match(/^\s*File "([\w.@/-]+\.py)", line (\d+), in \w+/u)
    if (m && Number(m[2]) > 0) frames.add(`${m[1]}:${m[2]}`)
  }
  if (frames.size < 2) return false
  // Same stack can be a fresh regression. Require the same individual request/trace/report,
  // or a pinned build AND the original failure time. Neither is manufactured from the title.
  const token = body.match(
    /\b(?:trace|request|incident|report)[ _-]?id\s*[:=]\s*([\da-f]{16,64}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\b/iu,
  )?.[1]
  const realistic = (v: string | undefined) =>
    !!v &&
    new Set(v.toLowerCase().replaceAll('-', '')).size >= 6 &&
    !/deadbeef|01234567|^(.{1,8})\1+$/iu.test(v)
  const build = body.match(
    /\b(?:commit|build[ _-]?sha|git[ _-]?sha)\s*[:=]\s*([\da-f]{12,64})\b/iu,
  )?.[1]
  return realistic(token) || (realistic(build) && Number.isFinite(failureTime(body)))
}

function failureTime(body: string) {
  const s = body.match(
    /\b(?:occurred[ _-]?at|failure[ _-]?time(?:stamp)?|error[ _-]?time(?:stamp)?|incident[ _-]?time|timestamp)\s*[:=]\s*(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))\b/iu,
  )?.[1]
  return time(s)
}

function pinned(
  issue: unknown,
  repository: string,
): issue is Row & {
  number: number
  id: number
  title: string
  body: string
  user: { id: number; type: 'User' }
} {
  if (
    !row(issue) ||
    !id(issue.id) ||
    !id(issue.number) ||
    issue.pull_request != null ||
    typeof issue.title !== 'string' ||
    typeof issue.body !== 'string' ||
    !row(issue.user) ||
    !id(issue.user.id) ||
    issue.user.type !== 'User' ||
    typeof issue.html_url !== 'string' ||
    typeof issue.repository_url !== 'string'
  )
    return false
  const lower = repository.toLowerCase()
  return (
    issue.repository_url.toLowerCase() === `https://api.github.com/repos/${lower}` &&
    issue.html_url.toLowerCase() === `https://github.com/${lower}/issues/${issue.number}`
  )
}

export interface ExactDuplicateLookup {
  repository: string
  /** Full current Issue from GitHub. The caller also pins the repository's immutable ID. */
  current: unknown
  /** Repository-relative GET; no caller-supplied URL or body is followed. */
  get: (path: string) => Promise<unknown>
  /** API search for a single page; truncated, stale or incomplete searches cannot authorize closing. */
  search: (q: string) => Promise<unknown>
}

/** Identify the same incident submitted a second time rather than a similar bug after a fix. */
export async function findExactResolvedDuplicate({
  repository,
  current,
  search,
  get,
}: ExactDuplicateLookup): Promise<{ number: number; id: number; url: string } | null> {
  if (
    !/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/iu.test(repository) ||
    /\/\.{1,2}$/u.test(repository)
  )
    return null
  if (
    !pinned(current, repository) ||
    current.state !== 'open' ||
    current.closed_at !== null ||
    current.comments !== 0 ||
    !Number.isFinite(time(current.created_at)) ||
    current.created_at !== current.updated_at ||
    current.title.length < 15 ||
    current.title.length > 240 ||
    (Array.isArray(current.assignees) && current.assignees.length > 0) ||
    current.milestone != null ||
    (Array.isArray(current.labels) &&
      current.labels.some((label) => {
        const name =
          typeof label === 'string'
            ? label
            : row(label) && typeof label.name === 'string'
              ? label.name
              : ''
        const text = name.replace(/[-_]/gu, ' ')
        return (
          keepOpen.test(text) ||
          regression.test(text) ||
          /needs investigation|under investigation|需调查|排查中/iu.test(text)
        )
      })) ||
    disputesDuplicate(`${current.title}\n${current.body}`) ||
    !distinctive(current.body) ||
    isUnsafeGithubComment(current.body)
  )
    return null
  // Use a plain word generated from the title, never allow query qualifiers, Boolean expressions
  // or title-supplied URLs. Require the *entire* result set for this query, across open and closed.
  const term = (current.title.match(/[a-z][a-z\d]{3,24}|[\p{Script=Han}]{2,8}/giu) ?? [])
    .filter(
      (w) =>
        !/^(?:github|repo|issue|closed|open|error|exception|failure|failed|bug|report|test|where|without|user|template)$/iu.test(
          w,
        ),
    )
    .sort((a, b) => b.length - a.length)[0]
  if (!term) return null
  const page = await search(`repo:${repository} is:issue in:title "${term}"`)
  if (
    !row(page) ||
    page.incomplete_results !== false ||
    !Array.isArray(page.items) ||
    page.items.length > 100 ||
    page.total_count !== page.items.length
  )
    return null
  const sameBody = normalizeBody(current.body)
  const matches = []
  const seen = new Set<number>()
  for (const item of page.items) {
    // Search card bodies can be missing or stale, so check every identical title against the canonical Issue.
    if (
      !row(item) ||
      !id(item.id) ||
      !id(item.number) ||
      typeof item.title !== 'string' ||
      item.pull_request != null ||
      seen.has(item.number) ||
      typeof item.repository_url !== 'string' ||
      item.repository_url.toLowerCase() !==
        `https://api.github.com/repos/${repository.toLowerCase()}`
    )
      return null
    seen.add(item.number)
    if (item.id === current.id || item.number === current.number) {
      if (item.id !== current.id || item.number !== current.number || item.title !== current.title)
        return null
      continue
    }
    if (item.title === current.title) matches.push(item)
  }
  // A just-opened Issue may not yet be indexed. It is not necessary to trust an absent
  // current row; we have its canonical GET and only act on one historical, fully reread report.
  if (matches.length === 0 || matches.length > 6) return null
  let found: { number: number; id: number; url: string } | null = null
  for (const item of matches) {
    const previous = await get(`/issues/${item.number}`)
    if (
      !pinned(previous, repository) ||
      previous.id !== item.id ||
      previous.number !== item.number ||
      previous.title !== current.title
    )
      return null
    if (normalizeBody(previous.body) !== sameBody) continue
    if (
      found ||
      previous.user.id !== current.user.id ||
      previous.state !== 'closed' ||
      previous.state_reason !== 'completed' ||
      !(
        time(previous.created_at) <= time(previous.closed_at) &&
        time(previous.closed_at) < time(current.created_at)
      ) ||
      (Number.isFinite(failureTime(current.body)) &&
        failureTime(current.body) > time(previous.closed_at))
    )
      return null
    found = {
      id: previous.id,
      number: previous.number,
      url: `https://github.com/${repository}/issues/${previous.number}`,
    }
  }
  return found
}
