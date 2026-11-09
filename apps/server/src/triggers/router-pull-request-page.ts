import { ordinalNumber } from './router-work-reply'

const pageNumber =
  /第\s*([1-9]\d*|[一二两三四五六七八九十]{1,3})\s*页|\bpage\s+([1-9]\d*)\b|\b(first)\s+page\b/iu
export function pullPageRequest(question: string) {
  const text = question.normalize('NFKC').toLowerCase()
  const match = pageNumber.exec(text)
  const page = match && (match[3] ? 1 : ordinalNumber(match[1] ?? match[2]))
  const pr = /\bprs?\b|pull requests?|拉取请求|合并请求/iu
  const words = text
    .replace(/(?:https?:\/\/github\.com\/)?[a-z\d-]+\/[a-z\d._-]+/giu, ' ')
    .replace(pageNumber, '')
    .replace(pr, '')
    .replace(/(?:这个|该|本)?(?:项目|仓库)(?:中|里)?|开放的?|的|[\s。.!?」』”]/gu, '')
    .replace(/^(?:那么|那)?(?:请你?|帮我|麻烦)?/u, '')
    .replace(/(?:呢|吧)$/u, '')
  const next =
    /^(?:(?:继续|接着|再)?(?:查看|看看|看)?(?:下一?页|更多)|(?:继续|接着)(?:查看|看看|看)|nextpage|showmore|more)$/iu.test(
      words,
    )
  const back = /^(?:(?:返回|回到|回|查看|看看|看)?上一?页|previouspage|prevpage)$/iu.test(words)
  const direction = next ? ('next' as const) : back ? ('previous' as const) : undefined
  return {
    page: page || undefined,
    mentionsPage: /页|\bpages?\b/iu.test(text),
    direction,
    only: !!direction || (!!page && /^(?:回到|返回|查看|看看|看)?$/u.test(words)),
    namesPR: pr.test(text),
  }
}

/** Narrow a plain request for the current inventory. Analysis and changes still use the general loop. */
export function asksForOpenPullRequests(question: string) {
  // Strip only the subject, location and page. Every remaining word must describe listing open PRs.
  // A request to review, filter, merge or notify about them must retain the general Router tools.
  const query = question
    .trim()
    .replace(/[」』”]+$/u, '')
    .replace(pageNumber, ' ')
    .replace(/(?:https?:\/\/github\.com\/)?[a-z\d-]+\/[a-z\d._-]+/giu, ' ')
    .replace(
      /(?:(?:刚才|刚刚|之前)(?:跟踪|查看|提到)的\s*)?(?:这(?:一)?个|那(?:一)?个|该|本|第\s*[\d一二三四五六七八九十]+\s*个)?\s*(?:GitHub\s*)?(?:项目|仓库)(?:里面|中|里)?/giu,
      ' ',
    )
    .replace(/\b(?:in|for|of)\s+(?:(?:this|that|the)\s+)?(?:repo(?:sitory)?|project)\b/giu, ' ')
  const listing =
    /^(?:(?:请你?|帮我|麻烦|再|那|然后|看看|看下|看一下|查(?:看|一下|下)?|列(?:出|一下)|列举|显示|有|哪些|所有|现有|现在|当前|目前|待合并|打开|未关闭|开放|的|还有|多少|个|\s)*(?:PRs?|拉取请求|合并请求)(?:列表|清单|有|现在|目前|哪些|几个|多少|呢|吧|[\s?？!！。.,，])*|(?:(?:please|list|show|me|what|are|all|the|current|open|existing)\s+)*(?:PRs?|pull requests?)(?:\s+(?:in|for|of))?[\s.?!]*)$/iu
  return listing.test(query.trim())
}
