import { describe, expect, test } from 'bun:test'
import {
  buildXSearchProbePayload,
  parseProbeResponse,
  parseRetryAfter,
  shouldStopAfterRecord,
  summarizeProbeRecords,
} from './probe'

describe('x-search usage probe', () => {
  test('builds a compact grok-4.3 x_search Responses payload', () => {
    const payload = buildXSearchProbePayload(
      {
        model: 'grok-4.3',
        query: 'X Premium x_search quota',
        maxOutputTokens: 80,
        enableImageUnderstanding: false,
        enableVideoUnderstanding: true,
      },
      2,
      new Date('2026-05-20T00:00:00.000Z'),
    )

    expect(payload).toMatchObject({
      model: 'grok-4.3',
      max_output_tokens: 80,
      store: false,
      tools: [{ type: 'x_search', enable_video_understanding: true }],
    })
    expect(payload.input[0]?.content).toContain('Quota probe request #2')
  })

  test('extracts usage and citation counts from successful responses', async () => {
    const response = new Response(
      JSON.stringify({
        id: 'resp_1',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'ok',
                annotations: [{ type: 'url_citation', url: 'https://x.com/xai/status/1' }],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 15,
          num_sources_used: 2,
          num_server_side_tools_used: 1,
          cost_in_usd_ticks: 1234,
          server_side_tool_usage_details: { x_search_calls: 1 },
        },
      }),
      {
        status: 200,
        headers: {
          'x-request-id': 'req_1',
          'set-cookie': 'secret=hidden',
        },
      },
    )

    const record = await parseProbeResponse(
      1,
      '2026-05-20T00:00:00.000Z',
      response,
      new Date('2026-05-20T00:00:01.000Z'),
    )

    expect(record).toMatchObject({
      ok: true,
      status: 200,
      responseId: 'resp_1',
      outputTextLength: 2,
      citationCount: 1,
      headers: { 'x-request-id': 'req_1' },
      usage: {
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 15,
        xSearchCalls: 1,
        serverSideToolsUsed: 1,
        sourcesUsed: 2,
        costUsdTicks: 1234,
      },
    })
    expect(record.headers).not.toHaveProperty('set-cookie')
  })

  test('records rate limit headers even on successful responses', async () => {
    const response = new Response(JSON.stringify({ usage: { total_tokens: 1 } }), {
      status: 200,
      headers: {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '7',
        'x-ratelimit-reset': '1779235260',
      },
    })

    const record = await parseProbeResponse(
      1,
      '2026-05-20T00:00:00.000Z',
      response,
      new Date('2026-05-20T00:00:01.000Z'),
    )

    expect(record.limit).toBeUndefined()
    expect(record.rateLimit).toEqual({
      limit: 100,
      remaining: 7,
      resetAt: '2026-05-20T00:01:00.000Z',
    })
    expect(
      summarizeProbeRecords([record], '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:01.000Z')
        .rateLimit,
    ).toEqual({
      observations: 1,
      minRemaining: 7,
      lastRemaining: 7,
      lastLimit: 100,
      nextResetAt: '2026-05-20T00:01:00.000Z',
    })
  })

  test('detects quota errors and reset hints', async () => {
    const response = new Response(
      JSON.stringify({
        code: 'quota_exceeded',
        message: 'You have reached your x_search usage limit. Try again in 2 hours.',
      }),
      {
        status: 429,
        headers: { 'retry-after': '120' },
      },
    )

    const record = await parseProbeResponse(
      3,
      '2026-05-20T00:00:00.000Z',
      response,
      new Date('2026-05-20T00:00:10.000Z'),
    )

    expect(record.ok).toBe(false)
    expect(record.limit).toMatchObject({
      isLimit: true,
      retryAfterSeconds: 120,
      resetAt: '2026-05-20T00:02:10.000Z',
    })
    expect(shouldStopAfterRecord(record, true)).toBe(true)
  })

  test('treats retry-after-only 429 responses as limit signals', async () => {
    const response = new Response(JSON.stringify({ message: 'temporarily unavailable' }), {
      status: 429,
      headers: { 'retry-after': '60' },
    })

    const record = await parseProbeResponse(
      4,
      '2026-05-20T00:00:00.000Z',
      response,
      new Date('2026-05-20T00:00:05.000Z'),
    )

    expect(record.limit).toMatchObject({
      isLimit: true,
      retryAfterSeconds: 60,
      resetAt: '2026-05-20T00:01:05.000Z',
    })
  })

  test('summarizes usage totals and first limit signal', async () => {
    const first = await parseProbeResponse(
      1,
      '2026-05-20T00:00:00.000Z',
      new Response(
        JSON.stringify({
          usage: {
            total_tokens: 5,
            server_side_tool_usage_details: { x_search_calls: 1 },
          },
        }),
        { status: 200 },
      ),
      new Date('2026-05-20T00:00:01.000Z'),
    )
    const second = await parseProbeResponse(
      2,
      '2026-05-20T00:00:02.000Z',
      new Response(JSON.stringify({ message: 'rate limit reached' }), { status: 429 }),
      new Date('2026-05-20T00:00:03.000Z'),
    )

    expect(
      summarizeProbeRecords(
        [first, second],
        '2026-05-20T00:00:00.000Z',
        '2026-05-20T00:00:03.000Z',
      ),
    ).toMatchObject({
      totalRequests: 2,
      successes: 1,
      failures: 1,
      firstLimitAt: '2026-05-20T00:00:03.000Z',
      totalUsage: { totalTokens: 5 },
      xSearch: { requestsWithXSearch: 1, requestsWithoutXSearch: 1 },
    })
  })

  test('parses retry-after seconds and dates', () => {
    const now = new Date('2026-05-20T00:00:00.000Z')

    expect(parseRetryAfter('30', now)).toEqual({
      seconds: 30,
      resetAt: '2026-05-20T00:00:30.000Z',
    })
    expect(parseRetryAfter('Wed, 20 May 2026 00:01:00 GMT', now)).toEqual({
      seconds: 60,
      resetAt: '2026-05-20T00:01:00.000Z',
    })
  })
})
