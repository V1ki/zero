import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditProject } from '../acceptance'
import { createIPVideoRoutes } from '../api'
import {
  CHUNK_LIMIT,
  CORRECTION_PROMPT,
  CORRECTION_PROMPT_VERSION,
  MODEL,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  hash,
} from '../extraction'
import { ProjectStore, atomicJson } from '../store'

const directories: string[] = []
const source =
  '书名\n第1章 相遇\n陈实牵着白马走进侯府的庭院。\n第2章 别离\n陈实拿着佩刀走出了侯府的庭院。'
function root() {
  const path = mkdtempSync(join(process.env.IP_VIDEO_TEST_TMP ?? tmpdir(), 'ip-video-test-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function modelResponse(init?: RequestInit, patch: Record<string, unknown> = {}) {
  const request = JSON.parse(String(init?.body))
  const text = JSON.parse(request.messages[1].content).text as string
  const quote = text.split('\n').find((line) => line.startsWith('陈实'))
  return Response.json({
    model: MODEL,
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            assets: quote
              ? [{ name: '陈实', kind: 'character', aliases: [], description: '原文人物', quote }]
              : [],
          }),
        },
      },
    ],
    ...patch,
  })
}
const models = () => Response.json({ data: [{ id: MODEL }] })
type RecordedRequest = { messages: { role: string; content: string }[]; temperature: number }
const quote = '陈实牵着白马走进侯府的庭院。'
const character = { name: '陈实', kind: 'character', aliases: [], description: '牵马', quote }
const location = { name: '侯府', kind: 'location', aliases: [], description: '庭院', quote }
const reply = (content: string) =>
  Response.json({
    model: MODEL,
    choices: [{ finish_reason: 'stop', message: { content } }],
  })

describe('IP video durable execution (fixture transport only)', () => {
  test('corrects all assets using only the latest response/error and records exact prompt provenance', async () => {
    const requests: RecordedRequest[] = []
    const contents = [
      JSON.stringify({
        assets: [
          { ...character, quote: '首轮虚构' },
          { ...location, aliases: ['府邸'] },
        ],
      }),
      JSON.stringify({ assets: [character, { ...location, quote: '第二轮虚构' }] }),
      JSON.stringify({ assets: [character, location] }),
    ]
    const store = new ProjectStore(
      root(),
      async (url, init) => {
        if (url.endsWith('/models')) return models()
        const request = JSON.parse(String(init?.body)) as RecordedRequest
        requests.push(request)
        if (requests.length > 1) {
          const state = store.read(id)
          expect(state.chunks[0].mentions).toHaveLength(0)
          expect(state.assets).toHaveLength(0)
          expect(store.view(id).progress.coveredUtf16).toBe(0)
        }
        return reply(contents[requests.length - 1])
      },
      1000,
      0,
    )
    const { id } = store.import('纠错', quote)
    await store.start(id)
    const result = store.read(id)
    expect(requests).toHaveLength(3)
    expect(requests.map((request) => request.messages.length)).toEqual([2, 4, 4])
    expect(requests.every((request) => request.temperature === 0)).toBe(true)
    expect(requests[1].messages[2]).toEqual({ role: 'assistant', content: contents[0] })
    expect(requests[1].messages[3].content).toContain('quote长度无效')
    expect(requests[1].messages[3].content).toContain('aliases未在同一个quote')
    expect(requests[2].messages[2]).toEqual({ role: 'assistant', content: contents[1] })
    expect(JSON.stringify(requests[2])).not.toContain('首轮虚构')
    expect(requests[2].messages[3].content).toContain('第二轮虚构')
    expect(JSON.parse(requests[0].messages[1].content).instructions).toBe(CORRECTION_PROMPT)
    expect(result.status).toBe('completed')
    expect(result.chunks[0].mentions).toHaveLength(2)
    expect(result.assets).toHaveLength(2)
    expect(result.promptVersion).toBe('ip-assets-quote-v1')
    const originalHash = '6a2445ca418c05d216882cec90e6e04791ee9abafb16e322f4d15757648b5ddf'
    expect(result.promptSha256).toBe(originalHash)
    expect(id).toBe(
      hash(`${hash(quote)}:ip-assets-quote-v1:${originalHash}:${CHUNK_LIMIT}:${MODEL}`).slice(
        0,
        24,
      ),
    )
    expect(readFileSync(join(store.directory(id), 'prompt.txt'), 'utf8')).toBe(SYSTEM_PROMPT)
    for (const [index, attempt] of result.chunks[0].attempts.entries()) {
      const artifact = JSON.parse(
        readFileSync(join(store.directory(id), attempt.responseFile ?? ''), 'utf8'),
      )
      expect(artifact.promptVersion).toBe(PROMPT_VERSION)
      expect(artifact.promptSha256).toBe(hash(SYSTEM_PROMPT))
      expect(artifact.effectiveSystemPromptSha256).toBe(hash(artifact.request.messages[0].content))
      expect(artifact.correctionPromptVersion).toBe(CORRECTION_PROMPT_VERSION)
      expect(artifact.correctionPromptSha256).toBe(hash(CORRECTION_PROMPT))
      expect(artifact.request).toEqual(requests[index])
      expect(artifact.requestSha256).toBe(hash(JSON.stringify(requests[index])))
    }
  })

  test('reopened failed chunk carries its last legacy error and response on the first request', async () => {
    const dir = root()
    const store = new ProjectStore(
      dir,
      async (url) =>
        url.endsWith('/models')
          ? models()
          : reply(JSON.stringify({ assets: [character, { ...location, aliases: ['府邸'] }] })),
      1000,
      0,
    )
    const { id } = store.import('历史纠错', quote)
    await store.start(id)
    const failed = store.read(id)
    expect(failed.status).toBe('failed')
    expect(failed.assets).toHaveLength(0)
    const last = failed.chunks[0].attempts.at(-1)
    if (!last?.responseFile) throw new Error('Missing failure artifact')
    const path = join(store.directory(id), last.responseFile)
    const artifact = JSON.parse(readFileSync(path, 'utf8'))
    // Legacy artifacts contain only rawResponse/request/attempt, no correction metadata.
    last.error = '原文引用校验失败：侯府'
    atomicJson(path, {
      rawResponse: artifact.rawResponse,
      request: artifact.request,
      attempt: last,
    })
    atomicJson(join(store.directory(id), 'project.json'), failed)
    let calls = 0
    const reopened = new ProjectStore(
      dir,
      async (url, init) => {
        if (url.endsWith('/models')) return models()
        calls++
        const request = JSON.parse(String(init?.body)) as RecordedRequest
        expect(request.messages).toHaveLength(4)
        expect(request.messages[2]).toEqual({
          role: 'assistant',
          content: JSON.parse(artifact.rawResponse).choices[0].message.content,
        })
        expect(JSON.parse(request.messages[3].content).previousError).toBe(last.error)
        expect(request.messages[3].content).toContain('aliases留空[]')
        return reply(JSON.stringify({ assets: [character, location] }))
      },
      1000,
      0,
    )
    await reopened.start(id, { retryFailed: true })
    expect(calls).toBe(1)
    expect(reopened.read(id).status).toBe('completed')
    expect(reopened.read(id).chunks[0].attempts).toHaveLength(4)
    expect(reopened.read(id).assets).toHaveLength(2)
  })

  test('a network retry carries the last error without reusing an older model response', async () => {
    const requests: RecordedRequest[] = []
    const store = new ProjectStore(
      root(),
      async (url, init) => {
        if (url.endsWith('/models')) return models()
        requests.push(JSON.parse(String(init?.body)))
        if (requests.length === 1) return reply('{bad-json-from-first-round')
        if (requests.length === 2) throw new Error('network fixture')
        return reply(JSON.stringify({ assets: [character] }))
      },
      1000,
      0,
    )
    const { id } = store.import('错误上下文', quote)
    await store.start(id)
    expect(requests[1].messages[2].content).toBe('{bad-json-from-first-round')
    expect(requests[1].messages[3].content).toContain('模型结果不是有效JSON')
    expect(requests[2].messages.map((message) => message.role)).toEqual(['system', 'user', 'user'])
    expect(JSON.stringify(requests[2])).not.toContain('bad-json-from-first-round')
    expect(requests[2].messages[2].content).toContain('network fixture')
    expect(store.read(id).status).toBe('completed')
  })

  test('original prompt version and saved prompt hash must match before any model call', async () => {
    for (const mode of ['version', 'prompt-file', 'hash']) {
      let calls = 0
      const store = new ProjectStore(root(), async () => {
        calls++
        return models()
      })
      const { id } = store.import('追溯完整性', quote)
      const project = store.read(id)
      if (mode === 'version') project.promptVersion = 'incorrect-version'
      if (mode === 'hash') project.promptSha256 = 'incorrect-hash'
      if (mode === 'prompt-file')
        writeFileSync(join(store.directory(id), 'prompt.txt'), 'altered prompt')
      atomicJson(join(store.directory(id), 'project.json'), project)
      await expect(store.start(id)).rejects.toThrow('完整性校验失败')
      expect(calls).toBe(0)
    }
  })

  test('HTTP import/analyze and SSE expose completed states without polling', async () => {
    const dir = root()
    const store = new ProjectStore(
      dir,
      async (url, init) => (url.endsWith('/models') ? models() : modelResponse(init)),
      1000,
      0,
    )
    const app = createIPVideoRoutes(store)
    const imported = await app.request('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'API测试', source }),
    })
    expect(imported.status).toBe(201)
    const { id } = (await imported.json()) as { id: string }
    const response = await app.request(`/projects/${id}/events`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing SSE stream')
    try {
      const initial = await reader.read()
      expect(new TextDecoder().decode(initial.value)).toContain('"status":"ready"')
      expect(
        (
          await app.request(`/projects/${id}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ concurrency: 6 }),
          })
        ).status,
      ).toBe(202)
      await store.wait(id)
      let lastEvent = ''
      while (!lastEvent.includes('"status":"completed"')) {
        const event = await reader.read()
        if (event.done) throw new Error('SSE ended before completion')
        lastEvent = new TextDecoder().decode(event.value)
      }
      expect(lastEvent).toContain('"status":"completed"')
      expect(
        (
          await app.request(`/projects/${id}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ concurrency: 20 }),
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await app.request(`/projects/${id}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ concurrency: 6 }),
          })
        ).status,
      ).toBe(202)
      await store.wait(id)
    } finally {
      await reader.cancel()
    }
  })

  test('six workers bound concurrency and duplicate starts share one run', async () => {
    let inflight = 0
    let maximum = 0
    let calls = 0
    const store = new ProjectStore(
      root(),
      async (url, init) => {
        if (url.endsWith('/models')) return models()
        calls++
        inflight++
        maximum = Math.max(maximum, inflight)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inflight--
        return modelResponse(init)
      },
      1000,
      0,
    )
    const { id } = store.import(
      '并发',
      Array.from(
        { length: 24 },
        (_, i) => `第${i + 1}章 测试\n陈实牵着白马走进侯府的庭院。\n`,
      ).join(''),
    )
    const first = store.start(id)
    const second = store.start(id)
    expect(first).toBe(second)
    await first
    expect(calls).toBe(24)
    expect(maximum).toBe(6)
    expect(store.read(id).status).toBe('completed')
  })

  test('all chunks, usage, raw requests, stable assets and full-source API persist across reopen', async () => {
    const dir = root()
    let calls = 0
    const store = new ProjectStore(
      dir,
      async (url, init) => {
        if (url.endsWith('/models')) return models()
        calls++
        return modelResponse(init)
      },
      1000,
      0,
    )
    const project = store.import('测试书', source)
    await store.start(project.id)
    const result = store.read(project.id)
    expect(result.status).toBe('completed')
    expect(calls).toBe(3)
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0].evidence).toHaveLength(2)
    expect(auditProject(result, source).requests.usage.total_tokens).toBe(450)
    expect(auditProject(result, source).extraction.allSucceeded).toBe(true)
    const attempt = result.chunks[0].attempts[0]
    if (!attempt.responseFile) throw new Error('Missing attempt artifact')
    const recorded = JSON.parse(
      readFileSync(join(store.directory(project.id), attempt.responseFile), 'utf8'),
    )
    expect(recorded.request.model).toBe(MODEL)
    expect(recorded.request.chat_template_kwargs.enable_thinking).toBe(false)
    const reopened = new ProjectStore(dir)
    const app = createIPVideoRoutes(reopened)
    expect(await (await app.request(`/projects/${project.id}/source`)).text()).toBe(source)
    for (const chapter of project.chapters)
      expect(
        await (await app.request(`/projects/${project.id}/chapters/${chapter.id}`)).text(),
      ).toBe(source.slice(chapter.start, chapter.end))
    await store.start(project.id)
    expect(calls).toBe(3)
    expect((await app.request('/projects/../../secret')).status).toBe(404)
    expect(
      (
        await app.request('/projects', {
          method: 'POST',
          headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'x', source }),
        })
      ).status,
    ).toBe(403)
  })

  test('invalid quotes exhaust retries, manual retry preserves success and evidence history', async () => {
    let broken = true
    const store = new ProjectStore(
      root(),
      async (url, init) => {
        if (url.endsWith('/models')) return models()
        const body = JSON.parse(String(init?.body))
        if (broken && JSON.parse(body.messages[1].content).text.includes('第2章'))
          return modelResponse(init, {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    assets: [
                      {
                        kind: 'character',
                        name: '不存在',
                        aliases: [],
                        description: '无',
                        quote: '不存在的人物出现在这段伪造引用里。',
                      },
                    ],
                  }),
                },
              },
            ],
          })
        return modelResponse(init)
      },
      1000,
      0,
    )
    const { id } = store.import('重试', source)
    await store.start(id)
    expect(store.read(id).status).toBe('failed')
    expect(store.read(id).chunks[2].attempts).toHaveLength(3)
    expect(store.read(id).chunks[2].mentions).toHaveLength(0)
    expect(auditProject(store.read(id), source).assets.rejectedQuoteAttempts).toBe(3)
    broken = false
    await store.start(id, { retryFailed: true })
    expect(store.read(id).status).toBe('completed')
    expect(store.read(id).chunks[0].attempts).toHaveLength(1)
    expect(store.read(id).chunks[2].attempts).toHaveLength(4)
  })

  test('unreachable model is visibly blocked without false coverage', async () => {
    const store = new ProjectStore(root(), async () => {
      throw new Error('EPERM fixture')
    })
    const { id } = store.import('阻塞', source)
    await store.start(id)
    expect(store.read(id).status).toBe('blocked')
    expect(store.view(id).progress.coveredUtf16).toBe(0)
    expect(store.read(id).chunks.every((c) => c.attempts.length === 0)).toBe(true)
  })

  test('restart recovers running attempts and keeps successful chunks', async () => {
    const dir = root()
    const store = new ProjectStore(
      dir,
      async (url, init) => (url.endsWith('/models') ? models() : modelResponse(init)),
      1000,
      0,
    )
    const project = store.import('恢复', source)
    await store.start(project.id)
    const interrupted = store.read(project.id)
    interrupted.status = 'running'
    interrupted.chunks[2].status = 'running'
    interrupted.chunks[2].mentions = []
    interrupted.chunks[2].attempts.push({
      id: 'crashed',
      startedAt: new Date().toISOString(),
      status: 'running',
    })
    atomicJson(join(store.directory(project.id), 'project.json'), interrupted)
    const recovered = new ProjectStore(
      dir,
      async (url, init) => (url.endsWith('/models') ? models() : modelResponse(init)),
      1000,
      0,
    )
    recovered.recover()
    expect(recovered.read(project.id).status).toBe('interrupted')
    expect(recovered.read(project.id).chunks[2].attempts.at(-1)?.status).toBe('interrupted')
    await recovered.start(project.id)
    expect(recovered.read(project.id).status).toBe('completed')
    expect(recovered.read(project.id).chunks[0].attempts).toHaveLength(1)
    expect(recovered.read(project.id).chunks[2].attempts).toHaveLength(3)
  })

  test('truncated output, wrong model and timeouts never become successful assets', async () => {
    for (const mode of ['truncated', 'wrong-model', 'timeout']) {
      const store = new ProjectStore(
        root(),
        async (url, init) => {
          if (url.endsWith('/models')) return models()
          if (mode === 'wrong-model') return modelResponse(init, { model: 'unexpected' })
          if (mode === 'truncated')
            return modelResponse(init, {
              choices: [{ finish_reason: 'length', message: { content: '{"assets":[]}' } }],
            })
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), {
              once: true,
            })
          })
        },
        10,
        0,
      )
      const { id } = store.import(mode, source)
      await store.start(id)
      expect(store.read(id).status).toBe('failed')
      expect(store.read(id).assets).toHaveLength(0)
      expect(store.read(id).chunks.every((c) => c.attempts.length === 3)).toBe(true)
    }
  })
})
