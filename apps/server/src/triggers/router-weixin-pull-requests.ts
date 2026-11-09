import type { RouterOpenPullRequestsPage } from '@zero-os/shared'

const markers = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Keep distinctive scope names from conventional commit titles. Full titles stay in the receipt. */
function previewTitle(title: string): string {
  const clean = title
    .replace(
      /^(?:fix|feat|docs|chore|refactor|perf|test|build|ci|style)(?:\(([^)]+)\))?!?:\s+/iu,
      (_prefix, scope?: string) => (scope ? `${scope} · ` : ''),
    )
    .replace(/https?:\/\/\S+/giu, '〔链接〕')
    .replace(/\s+/gu, ' ')
    .trim()
  let width = 0
  let preview = ''
  for (const { segment } of graphemes.segment(clean)) {
    width += /^[\x20-\x7e]+$/u.test(segment) ? 1 : 2
    if (width > 52) {
      const lastSpace = preview.lastIndexOf(' ')
      const midWord = /[a-z\d]$/iu.test(preview) && /^[a-z\d]/iu.test(segment)
      const clipped =
        midWord && lastSpace >= preview.length - 12 ? preview.slice(0, lastSpace) : preview
      return `${clipped.trimEnd()}…`
    }
    preview += segment
  }
  return preview
}

/** Plain text also serves as a fallback for IM adapters without rich replies. */
export function compactPullRequests(page: RouterOpenPullRequestsPage, weixin: boolean): string {
  const count = page.pullRequests.length
  if (!count)
    return page.page === 1
      ? `${page.repository}\n暂无开放 PR。`
      : `${page.repository}\n开放 PR 第 ${page.page} 页没有结果。`
  const heading =
    page.page === 1 && !page.nextPage ? `开放 PR · 共 ${count} 条` : `开放 PR · 第 ${page.page} 页`
  const rows = page.pullRequests.map(
    (pr, i) =>
      `${markers[i] ?? '•'}  #${pr.number}  ${pr.draft ? '〔草稿〕' : ''}${previewTitle(pr.title)}`,
  )
  const hint = [
    ...(page.nextPage ? ['回「下一页」继续'] : []),
    ...(weixin ? [`回「PR ${page.pullRequests[0].number}」看原文`] : []),
  ].join('，')
  return [`${page.repository}\n${heading}`, rows.join('\n\n'), hint].filter(Boolean).join('\n\n')
}

export function requestedWeixinPullNumber(question: string): number | undefined {
  const match =
    /^(?:(?:请|帮我)?\s*(?:查看|看一下|看看|看|打开)\s*)?PR\s*[#＃]?\s*([1-9]\d*)\s*(?:的?(?:原文|链接|完整标题))?[。.!！]?$/iu.exec(
      question,
    )
  const number = Number(match?.[1])
  return Number.isSafeInteger(number) ? number : undefined
}

/** Open only an entry actually returned for the previous page in this private chat. */
export function weixinPullRequestDetail(page: RouterOpenPullRequestsPage, number: number) {
  const pr = page.pullRequests.find((pr) => pr.number === number)
  if (!pr) return
  const url = `https://github.com/${page.repository}/pull/${pr.number}`
  if (pr.url !== url) return
  return [`${page.repository} · PR #${pr.number}${pr.draft ? '〔草稿〕' : ''}`, pr.title, url].join(
    '\n\n',
  )
}
