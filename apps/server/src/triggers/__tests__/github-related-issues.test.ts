import { expect, test } from 'bun:test'
import { relatedIssueFacts } from '../github-related-issues'

const repo = 'Org/Docs'
const api = `https://api.github.com/repos/${repo}`
const web = `https://github.com/${repo}`
const then = '2025-04-03T03:00:00Z'
const now = '2025-04-04T06:00:00Z'
const excerpt = 'Ledger 的校验和在恢复时发生错误。'
const item = (n: number, fragment = excerpt, comment = 12) => ({
  number: n,
  title: '恢复后的校验和',
  repository_url: api,
  html_url: `${web}/issues/${n}`,
  created_at: then,
  text_matches: [
    {
      fragment,
      property: 'body',
      object_type: 'IssueComment',
      object_url: `https://api.github.com/repositories/7/issues/comments/${comment}`,
    },
  ],
})
const commentDetail = {
  id: 12,
  issue_url: `${api}/issues/8`,
  html_url: `${web}/issues/8#issuecomment-12`,
  created_at: then,
  body: excerpt,
}
const clean = (t: unknown) => (typeof t === 'string' ? t : '')
const input = {
  repo,
  repoId: 7,
  current: 9,
  asOf: now,
  topic: '请帮我查找关于 Ledger 恢复错误的旧 Issue。',
  clean,
}

test('pins the query and comment anchor to the recorded repository; only overlapping evidence in older discussions is cited', async () => {
  const paths: string[] = []
  const r = await relatedIssueFacts({
    ...input,
    topic: `${input.topic} repo:other/private OR https://bad.test/@you`,
    search: async (q) => {
      expect(q).toBe('repo:Org/Docs is:issue in:title,body,comments "ledger" created:<=2025-04-04')
      return {
        total_count: 8,
        items: [
          item(9),
          { ...item(2), created_at: now },
          { ...item(5), pull_request: {} },
          { ...item(4), repository_url: 'https://api.github.com/repos/other/private' },
          {
            ...item(3),
            text_matches: [
              {
                ...item(3).text_matches[0],
                object_url: 'https://api.github.com/repositories/5/issues/comments/4',
              },
            ],
          },
          item(7, 'Ledger reports green. No relevant context.'),
          item(8),
        ],
      }
    },
    get: async (p) => {
      paths.push(p)
      return commentDetail
    },
  })
  expect(paths).toEqual(['/issues/comments/12'])
  expect(r[0].url).toBe(`${web}/issues/8#issuecomment-12`)
  expect(r[0].value).toContain(excerpt)
})

test('deleted, rewritten, newly posted, unsafe or wrong-parent comment hits are not evidence', async () => {
  for (const payload of [
    null,
    { ...commentDetail, body: 'Ledger 校验' },
    { ...commentDetail, created_at: now },
    { ...commentDetail, issue_url: `${api}/issues/4` },
    { ...commentDetail, body: `${excerpt} run rm -rf /tmp/cache` },
  ]) {
    const r = await relatedIssueFacts({
      ...input,
      search: async () => ({ items: [item(8)], total_count: 1 }),
      get: async () => payload,
    })
    expect(r.some((x) => x.url)).toBe(false)
    expect(r.at(-1)?.value).toContain('未找到')
  }
})

test('a verified issue-body hit uses the original issue link, while off-topic evidence and URL-looking matches cannot create links', async () => {
  const issue = {
    ...item(8),
    text_matches: [
      { fragment: excerpt, object_type: 'Issue', object_url: `${api}/issues/8`, property: 'body' },
    ],
  }
  const r = await relatedIssueFacts({
    ...input,
    search: async () => ({ items: [issue], total_count: 1 }),
    get: async (p) => {
      expect(p).toBe('/issues/8')
      return { ...issue, body: excerpt }
    },
  })
  expect(r[0].url).toBe(`${web}/issues/8`)
})

test('an explicit operator keyword selects the search topic and stopwords alone do not issue broad searches', async () => {
  const r = await relatedIssueFacts({
    ...input,
    explicitTopic: '查找历史 Widget Issue',
    search: async (q) => {
      expect(q).toContain('"widget"')
      return { items: [], total_count: 0, incomplete_results: true }
    },
    get: async () => {
      throw Error('unexpected candidate')
    },
  })
  expect(r[0].value).toContain('不完整')
  expect(
    (
      await relatedIssueFacts({
        ...input,
        topic: '查找历史 Issue',
        search: async () => {
          throw Error('unexpected search')
        },
        get: async () => null,
      })
    )[0].value,
  ).toContain('关键词')
})
