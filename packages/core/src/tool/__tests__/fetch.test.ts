import { describe, expect, test } from 'bun:test'
import { FetchTool } from '../fetch'

const FETCH_TIMEOUT = 30_000

const ctx = {
  sessionId: 'test_fetch_session',
  workDir: process.cwd(),
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}

describe('FetchTool', () => {
  const tool = new FetchTool()

  test('has correct name and description', () => {
    expect(tool.name).toBe('fetch')
    expect(tool.description).toContain('HTTP')
  })

  test('returns error for missing url', async () => {
    const result = await tool.run(ctx, {})
    expect(result.success).toBe(false)
    expect(result.output).toContain('missing required fields')
    expect(result.output).toContain('url')
  })

  test(
    'fetches HTML page and converts to markdown',
    async () => {
      const result = await tool.run(ctx, { url: 'https://example.com' })
      expect(result.success).toBe(true)
      expect(result.output).toContain('HTTP 200')
      expect(result.output).toContain('Example Domain')
    },
    FETCH_TIMEOUT,
  )

  test(
    'fetches JSON API',
    async () => {
      const result = await tool.run(ctx, {
        url: 'https://httpbin.org/json',
        format: 'json',
      })
      expect(result.success).toBe(true)
      expect(result.output).toContain('HTTP 200')
    },
    FETCH_TIMEOUT,
  )

  test(
    'auto-detects JSON content type',
    async () => {
      const result = await tool.run(ctx, {
        url: 'https://httpbin.org/json',
      })
      expect(result.success).toBe(true)
      // Auto-detected as JSON, should be formatted
      expect(result.output).toContain('HTTP 200')
    },
    FETCH_TIMEOUT,
  )

  test('handles non-existent domain', async () => {
    const result = await tool.run(ctx, {
      url: 'https://this-domain-does-not-exist-zero-os.invalid',
      timeout: 5000,
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('Fetch failed')
  }, 10_000)

  test(
    'reports HTTP error status',
    async () => {
      const result = await tool.run(ctx, {
        url: 'https://httpbin.org/status/404',
      })
      expect(result.success).toBe(false)
      expect(result.output).toContain('HTTP 404')
    },
    FETCH_TIMEOUT,
  )

  test('credentialRef fails without secretResolver', async () => {
    const result = await tool.run(ctx, {
      url: 'https://example.com',
      credentialRef: 'my_api_key',
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('no secretResolver available')
  })

  test('credentialRef fails when secret not found', async () => {
    const ctxWithResolver = {
      ...ctx,
      secretResolver: () => undefined,
    }
    const result = await tool.run(ctxWithResolver, {
      url: 'https://example.com',
      credentialRef: 'nonexistent_key',
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('not found in vault')
  })

  test(
    'credentialRef injects Authorization header',
    async () => {
      const ctxWithResolver = {
        ...ctx,
        secretResolver: (ref: string) => (ref === 'test_token' ? 'secret123' : undefined),
      }
      // Use httpbin to echo headers back
      const result = await tool.run(ctxWithResolver, {
        url: 'https://httpbin.org/headers',
        credentialRef: 'test_token',
        format: 'json',
      })
      expect(result.success).toBe(true)
      expect(result.output).toContain('Bearer secret123')
    },
    FETCH_TIMEOUT,
  )

  test(
    'text format returns raw content',
    async () => {
      const result = await tool.run(ctx, {
        url: 'https://example.com',
        format: 'text',
      })
      expect(result.success).toBe(true)
      expect(result.output).toContain('HTTP 200')
      // Raw HTML, not markdown
      expect(result.output).toContain('<')
    },
    FETCH_TIMEOUT,
  )

  test(
    'POST with body works',
    async () => {
      const result = await tool.run(ctx, {
        url: 'https://httpbin.org/post',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
        format: 'json',
      })
      expect(result.success).toBe(true)
      expect(result.output).toContain('HTTP 200')
      expect(result.output).toContain('hello')
    },
    FETCH_TIMEOUT,
  )

  test('timeout returns the timeout result and truly cancels the request', async () => {
    const originalFetch = globalThis.fetch
    let observedSignal: AbortSignal | undefined
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }) as typeof fetch
    try {
      const result = await tool.run(ctx, { url: 'https://example.com/never', timeout: 60 })
      expect(result.success).toBe(false)
      expect(result.output).toBe('Request timed out after 60ms: https://example.com/never')
      expect(result.outputSummary).toBe('Timeout')
      // tryPromise wires fiber interruption into the AbortSignal: the timeout
      // must abort the in-flight request, not merely stop awaiting it.
      await Bun.sleep(30)
      expect(observedSignal?.aborted).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 5000)

  test('network errors map to the Fetch failed result', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    try {
      const result = await tool.run(ctx, { url: 'https://example.com' })
      expect(result.success).toBe(false)
      expect(result.output).toBe('Fetch failed: fetch failed')
      expect(result.outputSummary).toBe('Fetch error: fetch failed')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
