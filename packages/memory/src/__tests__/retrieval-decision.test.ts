import { describe, expect, test } from 'bun:test'
import { buildRetrievalDecisionPrompt, parseRetrievalDecision } from '../retrieval-decision'

describe('buildRetrievalDecisionPrompt', () => {
  test('contains user message in output', () => {
    const result = buildRetrievalDecisionPrompt('上次那个 bug 修了吗？', '用户是后端开发者')
    expect(result).toContain('上次那个 bug 修了吗？')
    expect(result).toContain('<user_message>')
  })

  test('contains identity summary', () => {
    const result = buildRetrievalDecisionPrompt('hello', '用户偏好 TypeScript')
    expect(result).toContain('用户偏好 TypeScript')
    expect(result).toContain('<identity_summary>')
  })

  test('includes URL and external service retrieval scenarios', () => {
    const result = buildRetrievalDecisionPrompt(
      '分析这个链接 https://x.com/openai/status/123',
      '用户偏好 TypeScript',
    )

    expect(result).toContain('用户提供了 URL 链接')
    expect(result).toContain('访问特定网站、平台或外部服务')
    expect(result).toContain('浏览器、爬虫或特定 API 接入方式')
  })
})

describe('parseRetrievalDecision', () => {
  test('parses valid JSON with need=true and queries', () => {
    const input = '{"need": true, "queries": ["bug修复", "上次部署"]}'
    const result = parseRetrievalDecision(input)
    expect(result.need).toBe(true)
    expect(result.queries).toEqual(['bug修复', '上次部署'])
  })

  test('parses need=false', () => {
    const input = '{"need": false}'
    const result = parseRetrievalDecision(input)
    expect(result.need).toBe(false)
    expect(result.queries).toBeUndefined()
  })

  test('returns need=false for malformed/non-JSON input', () => {
    expect(parseRetrievalDecision('this is not json')).toEqual({ need: false })
    expect(parseRetrievalDecision('')).toEqual({ need: false })
    expect(parseRetrievalDecision('{ broken')).toEqual({ need: false })
  })

  test('limits queries to 3', () => {
    const input = '{"need": true, "queries": ["q1", "q2", "q3", "q4", "q5"]}'
    const result = parseRetrievalDecision(input)
    expect(result.need).toBe(true)
    expect(result.queries).toHaveLength(3)
    expect(result.queries).toEqual(['q1', 'q2', 'q3'])
  })

  test('extracts JSON from surrounding text', () => {
    const input = '根据分析，结果如下：\n{"need": true, "queries": ["历史记录"]}\n以上是我的判断。'
    const result = parseRetrievalDecision(input)
    expect(result.need).toBe(true)
    expect(result.queries).toEqual(['历史记录'])
  })
})
