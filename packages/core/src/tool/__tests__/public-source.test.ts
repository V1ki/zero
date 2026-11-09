import { expect, test } from 'bun:test'
import { createPublicSourceReader } from '../public-source'

const signal = () => new AbortController().signal
const resolve = async () => [{ address: '93.184.216.34', family: 4 }]

test('public research reads primary JSON fields and preserves evidence provenance', async () => {
  const calls: string[] = []
  const read = createPublicSourceReader({
    resolve,
    get: async (url, address) => {
      calls.push(url.href)
      expect(address.address).toBe('93.184.216.34')
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          time: { '1.2.3': '2026-01-01T00:00:00Z' },
          rules: { 'a/b': false },
        }),
      }
    },
  })
  const out = await read(
    {
      url: 'https://example.com/release',
      jsonPointers: ['/time/1.2.3', '/rules/a~1b', '/missing'],
    },
    signal(),
  )
  expect(JSON.parse(out.content)).toEqual({
    '/time/1.2.3': '2026-01-01T00:00:00Z',
    '/rules/a~1b': false,
    '/missing': { missing: true },
  })
  expect(out.url).toBe(calls[0])
  expect(Number.isFinite(Date.parse(out.observedAt))).toBe(true)
  expect(out.nextOffset).toBeNull()
})

test('private, mixed DNS, IPv6 loopback and mapped addresses never reach transport', async () => {
  let called = false
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '2002:7f00:1::',
  ]) {
    const read = createPublicSourceReader({
      resolve: async () => [
        ...(await resolve()),
        { address, family: address.includes(':') ? 6 : 4 },
      ],
      get: async () => {
        called = true
        throw Error('must not request')
      },
    })
    await expect(read({ url: 'https://example.com' }, signal())).rejects.toThrow('内网')
  }
  expect(called).toBe(false)
})

test('each redirect revalidates DNS and rejects credential or protocol changes', async () => {
  for (const location of [
    'https://private.example/',
    'http://example.com/',
    'https://user:pass@example.com/',
    'https://example.com:8443/',
  ]) {
    let count = 0
    const read = createPublicSourceReader({
      resolve: async (host) =>
        host === 'private.example' ? [{ address: '192.168.1.1', family: 4 }] : resolve(),
      get: async () => {
        count++
        return { status: 302, contentType: '', body: '', location }
      },
    })
    await expect(read({ url: 'https://example.com' }, signal())).rejects.toThrow()
    expect(count).toBe(1)
  }
})

test('long text can be continued without silently losing evidence; HTML links survive extraction', async () => {
  const content = `${'a'.repeat(16000)}IMPORTANT NEGATIVE RESULT`
  const read = createPublicSourceReader({
    resolve,
    get: async () => ({ status: 200, contentType: 'text/plain', body: content }),
  })
  const first = await read({ url: 'https://example.com' }, signal())
  expect(first.nextOffset).toBe(16000)
  const last = await read(
    { url: 'https://example.com', offset: first.nextOffset ?? undefined },
    signal(),
  )
  expect(last.content).toBe('IMPORTANT NEGATIVE RESULT')
  expect(last.nextOffset).toBeNull()
  const html = createPublicSourceReader({
    resolve,
    get: async () => ({
      status: 200,
      contentType: 'text/html',
      body: '<html><body><article><h1>Release rules</h1><p>The rule depends on the version. <a href="https://example.com/source">Original source</a></p></article></body></html>',
    }),
  })
  expect((await html({ url: 'https://example.com' }, signal())).content).toContain(
    '[Original source](https://example.com/source)',
  )
})

test('abort and unsuccessful responses cannot be presented as evidence', async () => {
  const stop = new AbortController()
  stop.abort()
  const read = createPublicSourceReader({
    resolve,
    get: async () => ({ status: 404, contentType: 'text/plain', body: 'missing' }),
  })
  await expect(read({ url: 'https://example.com' }, stop.signal)).rejects.toThrow()
  await expect(read({ url: 'https://example.com' }, signal())).rejects.toThrow('HTTP 404')
})
