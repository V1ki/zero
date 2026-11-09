import type {
  RouterOpenPullRequestsPage,
  TriggerConversationAnswer,
} from './types/trigger-conversation'

export function openPullRequestsReply(data: RouterOpenPullRequestsPage): string {
  const { repository, pullRequests, page, nextPage } = data
  if (!pullRequests.length) {
    return page === 1
      ? `${repository} 当前没有开放的 PR。`
      : `${repository} 的开放 PR 第 ${page} 页没有结果。`
  }
  const heading =
    page === 1 && nextPage === null
      ? `${repository} 当前有 ${pullRequests.length} 个开放 PR。`
      : `${repository} 的开放 PR，第 ${page} 页。`
  return [
    heading,
    ...pullRequests.map(
      (pr) => `#${pr.number} ${pr.title}${pr.draft ? '（草稿）' : ''}\n${pr.url}`,
    ),
    ...(nextPage === null ? [] : [`可以继续查看第 ${nextPage} 页。`]),
  ].join('\n')
}

/** Other tool results and errors must remain visible alongside their original text. */
export function isStandalonePullRequestAnswer(
  answer: TriggerConversationAnswer,
): answer is TriggerConversationAnswer & { pullRequests: RouterOpenPullRequestsPage } {
  return (
    !!answer.pullRequests &&
    !answer.pullRequestNumber &&
    !answer.job &&
    !answer.tracking &&
    !answer.repositories &&
    !answer.points?.length &&
    answer.text === openPullRequestsReply(answer.pullRequests)
  )
}
