import { expect, test } from 'bun:test'
import type { TriggerConversationAnswer, TriggerConversationTurn } from '@zero-os/shared'
import { resolveRouterTrackingRequest } from '../router-tracking-intent'
import { resolveJobRepository } from '../router-work-reply'

const project = 'V1ki/dsh-plugin-subscriptions'
function turn(answer: TriggerConversationAnswer, question = ''): TriggerConversationTurn {
  return {
    id: 1,
    requestId: 'req',
    question,
    answer,
    status: 'completed',
    error: null,
    createdAt: '',
    updatedAt: '',
  }
}
const tracked = turn({
  text: 'Saved',
  tracking: { id: 1, repository: project, issues: true, pullRequests: true, deliveryMode: 'poll' },
})
const question = '帮我查一下这个项目里面现有的 PR。'
const listed = { page: 1, repositories: ['Other/old', 'Other/current'], nextPage: null }

test('a verified subscription supplies the project for both an IM follow-up and a worker', () => {
  expect(resolveJobRepository(question, undefined, undefined, [tracked])).toBe(project)
  expect(resolveJobRepository(question, project.toLowerCase(), undefined, [tracked], true)).toBe(
    project,
  )
  expect(resolveJobRepository('查一下现在的 PR', undefined, undefined, [tracked], true)).toBe(
    project,
  )
  expect(resolveJobRepository('整理今天的文档', undefined, undefined, [tracked])).toBeUndefined()
  expect(() => resolveJobRepository(question, 'Other/old', undefined, [tracked])).toThrow()
  expect(resolveRouterTrackingRequest('监听这个项目的 Issue 评论', [tracked]).repository).toBe(
    project,
  )
})

test('a later change of repository, multi-repository list or unverified topic switch supersedes old focus', () => {
  const read = turn({
    text: '',
    pullRequests: { repository: 'Other/current', page: 1, nextPage: null, pullRequests: [] },
  })
  expect(resolveJobRepository(question, undefined, undefined, [tracked, read])).toBe(
    'Other/current',
  )
  expect(
    resolveJobRepository('查 Other/explicit 的 PR', undefined, undefined, [tracked], true),
  ).toBe('Other/explicit')
  const listing = turn({ text: '', repositories: listed })
  for (const history of [
    [tracked, listing],
    [tracked, turn({ text: '仓库不可见' }, '查看 Other/unavailable 的 PR')],
    [turn({ text: '跟踪了 Other/invented' })],
  ]) {
    expect(() => resolveJobRepository(question, project, undefined, history)).toThrow()
  }
  expect(resolveJobRepository('查第二个仓库的 PR', undefined, listed, [tracked, listing])).toBe(
    'Other/current',
  )
  expect(() =>
    resolveJobRepository('查第二个仓库 Other/first 的 PR', undefined, listed, [tracked, listing]),
  ).toThrow()
  expect(() =>
    resolveJobRepository('查另一个项目的 PR', project, undefined, [tracked], true),
  ).toThrow()
  expect(() => resolveJobRepository('不要查这个项目', undefined, undefined, [tracked])).toThrow()
})
