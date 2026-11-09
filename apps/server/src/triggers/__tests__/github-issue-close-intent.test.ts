import { expect, test } from 'bun:test'
import type { TriggerInboxItem } from '@zero-os/shared'
import { requestsCurrentIssueClose } from '../github-issue-close-intent'
const event: TriggerInboxItem = {
  source: 'github',
  id: 5,
  scope: 'owner/repo',
  url: 'https://github.com/owner/repo/issues/181#issuecomment-456',
  title: 'Issue #181',
  summary: '旧讨论是 #159',
  eventId: '22:comment:456',
  receivedAt: new Date().toISOString(),
  occurredAt: new Date().toISOString(),
}
test('only unqualified, affirmative instructions on the current Issue authorize closure', () => {
  for (const command of [
    '关闭 这个 issue .',
    '把这个 issue 关了吧',
    '帮我关闭这个 Issue 吧',
    '请把当前 issue 关一下',
    '请关闭 #181',
    'close issue #181',
    'Please close this issue.',
  ])
    expect(requestsCurrentIssueClose(command, event)).toBe(true)
  for (const command of [
    '为什么不关这个 issue',
    '关闭这个 issue？',
    '关闭 #159',
    '帮我找之前关闭的 issue',
    '先别关闭这个 issue',
    'close this issue if it is fixed',
    '关闭这个 Worker 工单',
    '关闭这个工单',
    '如果重复就关闭这个 issue',
    '举个例子：「关闭这个 issue」',
    '`close this issue`',
    'close this issue\nOnly if safe',
    '关闭 issue 并合并 PR',
  ])
    expect(requestsCurrentIssueClose(command, event)).toBe(false)
  expect(
    requestsCurrentIssueClose('close this issue', {
      ...event,
      url: 'https://github.com/owner/repo/pull/181',
    }),
  ).toBe(false)
})
