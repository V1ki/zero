import type { GithubInvestigation } from '@zero-os/shared'
import { isUnsafeGithubComment } from './github-comment-safety'

type Row = Record<string, unknown>
type Fact = GithubInvestigation['facts'][number]
const object = (x: unknown): x is Row => x !== null && typeof x === 'object' && !Array.isArray(x)
const stopWords = new Set(
  'a an the is it in on at of or and not with that this to do does did was for its would could should please me help my can will just link find search old earlier related previous issue issues pr github discussion comment comments repo repository thread ticket like maybe could this about according 查找 搜索 相关 关于 链接 历史 原来 之前 先前 此前 以前 可能 好像 一个 这个 那个 这里 那些 对于 可以 一下 看看 帮忙 帮助 提到 问题 仓库 讨论 评论 麻烦 说过 给我 请问 有没有 查一下 事件 已经'.split(
    ' ',
  ),
)
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

// Never interpret text from GitHub as a search expression (repo: / OR / arbitrary URLs).
function keywords(text: string): string[] {
  const plain = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(
      /https?:\/\/\S+|@[\w.-]+(?:\[bot\])?|\b[a-z][a-z-]*:[^\s]+|\b[a-z\d_.-]+\/[a-z\d_.-]+/giu,
      ' ',
    )
  const terms = Array.from(segmenter.segment(plain), ({ segment }) => segment).filter(
    (w) => /^(?:[a-z][a-z\d_-]{1,35}|[\p{Script=Han}]{2,12})$/u.test(w) && !stopWords.has(w),
  )
  return [...new Set(terms)].slice(0, 30)
}

export interface RelatedIssueReader {
  repo: string
  repoId: number
  current: number
  asOf: string
  topic: string
  /** Contents have been passed through the vault filter. */
  explicitTopic?: string
  search: (query: string) => Promise<Row>
  get: (path: string) => Promise<Row | null>
  clean: (value: unknown) => string
}

export async function relatedIssueFacts(input: RelatedIssueReader): Promise<Fact[]> {
  const { repo, repoId, current, asOf, search, get, clean } = input
  const explicit = keywords(input.explicitTopic ?? '')
  const terms = [...new Set([...explicit, ...keywords(input.topic)])].slice(0, 24)
  const cutoff = Date.parse(asOf)
  const base = `https://github.com/${repo}`
  const api = `https://api.github.com/repos/${repo}`
  if (!terms.length || !Number.isFinite(cutoff))
    return [
      {
        label: '查询范围',
        value: '没有足够的主题词可检索。请在事件对话中给出关键词，例如组件名或错误信息。',
      },
    ]
  const preferred = explicit.length ? explicit : terms
  const anchor = preferred.find((w) => /^[a-z]/u.test(w)) ?? preferred[0]
  const query = `repo:${repo} is:issue in:title,body,comments "${anchor}" created:<=${new Date(cutoff).toISOString().slice(0, 10)}`
  const data = await search(query)
  if (!Array.isArray(data.items) || typeof data.total_count !== 'number')
    throw new Error('GitHub 未返回可核对的 Issue 搜索结果。')
  const normalize = (s: string) => s.normalize('NFKC').toLowerCase()
  const hits = (s: string) => terms.filter((term) => normalize(s).includes(term)).length
  const relevant = (s: string) =>
    normalize(s).includes(anchor) && hits(s) >= Math.min(2, terms.length)
  type Match = {
    n: number
    title: string
    fragment: string
    comment: number | null
    score: number
    property: 'body' | 'title'
  }
  const candidates: Match[] = []
  for (const item of data.items.slice(0, 40)) {
    if (
      !object(item) ||
      item.pull_request != null ||
      !Number.isSafeInteger(item.number) ||
      Number(item.number) <= 0 ||
      Number(item.number) === current ||
      typeof item.repository_url !== 'string' ||
      normalize(item.repository_url) !== normalize(api) ||
      typeof item.html_url !== 'string' ||
      normalize(item.html_url) !== normalize(`${base}/issues/${item.number}`) ||
      typeof item.created_at !== 'string' ||
      !(Date.parse(item.created_at) < cutoff) ||
      !Array.isArray(item.text_matches)
    )
      continue
    const n = Number(item.number)
    for (const m of item.text_matches) {
      if (
        !object(m) ||
        typeof m.fragment !== 'string' ||
        typeof m.object_url !== 'string' ||
        !['title', 'body'].includes(String(m.property)) ||
        !relevant(m.fragment) ||
        isUnsafeGithubComment(m.fragment)
      )
        continue
      const url = normalize(m.object_url)
      const paths = [normalize(api), `https://api.github.com/repositories/${repoId}`]
      let comment: number | null = null
      if (m.object_type === 'IssueComment') {
        const suffix = url.match(/\/issues\/comments\/([1-9]\d*)$/u)
        if (
          !suffix ||
          !Number.isSafeInteger(Number(suffix[1])) ||
          !paths.some((path) => url === path + suffix[0])
        )
          continue
        comment = Number(suffix[1])
      } else if (m.object_type !== 'Issue' || !paths.some((path) => url === `${path}/issues/${n}`))
        continue
      candidates.push({
        n,
        title: clean(item.title),
        fragment: m.fragment,
        comment,
        score: hits(m.fragment),
        property: m.property === 'title' ? 'title' : 'body',
      })
    }
  }
  const seen = new Set<number>()
  const facts: Fact[] = []
  for (const c of candidates.sort((a, b) => b.score - a.score).slice(0, 8)) {
    if (seen.has(c.n)) continue
    const { comment, n } = c
    let url = `${base}/issues/${n}`
    let currentText: unknown
    if (comment !== null) {
      // A search index fragment can be stale. Check parent, author-visible body and exact permalink.
      const detail = await get(`/issues/comments/${comment}`)
      url += `#issuecomment-${comment}`
      if (
        !detail ||
        detail.id !== comment ||
        typeof detail.issue_url !== 'string' ||
        normalize(detail.issue_url) !== normalize(`${api}/issues/${n}`) ||
        typeof detail.html_url !== 'string' ||
        normalize(detail.html_url) !== normalize(url) ||
        typeof detail.created_at !== 'string' ||
        !(Date.parse(detail.created_at) < cutoff)
      )
        continue
      currentText = detail.body
    } else {
      const detail = await get(`/issues/${n}`)
      if (
        !detail ||
        detail.number !== n ||
        detail.pull_request != null ||
        typeof detail.repository_url !== 'string' ||
        normalize(detail.repository_url) !== normalize(api) ||
        typeof detail.html_url !== 'string' ||
        normalize(detail.html_url) !== normalize(url)
      )
        continue
      currentText = detail[c.property]
    }
    if (
      typeof currentText !== 'string' ||
      isUnsafeGithubComment(currentText) ||
      !relevant(currentText) ||
      !normalize(currentText.replace(/\s+/gu, ' ')).includes(
        normalize(c.fragment.trim().replace(/\s+/gu, ' ')),
      )
    )
      continue
    const excerpt = clean(c.fragment)
    if (!excerpt) continue
    facts.push({
      label: `Issue #${n} · ${comment ? '评论证据' : '标题或正文'}`,
      value: `${c.title}：${excerpt}`,
      url,
    })
    seen.add(n)
    if (facts.length === 3) break
  }
  return [
    ...facts,
    {
      label: '检索范围',
      value: `在 ${repo} 的历史 Issue 标题、正文和评论中检索「${anchor}」，最多检查 40 条，排除了当前讨论。${facts.length ? '以上是与本次主题有文字依据的候选。' : '在此次检索范围内未找到可核对的关联证据。'}${data.incomplete_results === true ? 'GitHub 返回了不完整的结果。' : ''}`,
    },
  ]
}
