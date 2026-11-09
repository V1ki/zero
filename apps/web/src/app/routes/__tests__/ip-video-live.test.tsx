import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { Asset, ProjectView } from '../../../ip-video/types'
import { IPVideoPage } from '../ip-video'
import { IPVideoLive } from '../ip-video-live'

// DOM interaction tests with fixture HTTP/SSE. No listener, model, or persistent store is used.
const text = `第1章 相遇\r\n🐎陈实牵马。\n\n${'完整正文不可截断。\n'.repeat(150)}`
const secondText = '第2章 离别\n陈实离开庭院。\n'
const assets: Asset[] = Array.from({ length: 14 }, (_, index) => ({
  id: `person-${index}`,
  name: `人物${index}`,
  kind: 'character',
  aliases: [`别名${index}`],
  descriptions: [`人物${index}的首条描述。`, '必须折叠的第二条描述。'],
  evidence: [
    {
      chapterId: 'c2',
      chunkId: 'k2',
      chapterOffset: 7,
      start: text.length + 7,
      end: text.length + 14,
      quote: '陈实离开庭院。',
    },
  ],
}))
assets.push({
  id: 'courtyard',
  kind: 'location',
  name: '庭院',
  aliases: [],
  descriptions: ['真实场景描述'],
  evidence: [],
})
assets.push({
  id: 'horse',
  kind: 'prop',
  name: '马',
  aliases: [],
  descriptions: ['真实道具描述'],
  evidence: [],
})
function fixture(): ProjectView {
  const chapters = [
    { id: 'c1', title: '第1章 相遇', number: 1, start: 0, end: text.length, chunkIds: ['k1'] },
    {
      id: 'c2',
      title: '第2章 离别',
      number: 2,
      start: text.length,
      end: text.length + secondText.length,
      chunkIds: ['k2'],
    },
  ]
  return {
    schemaVersion: 1,
    id: 'fixture-project',
    title: 'UI 隔离测试小说',
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    sourceSha256: 'fixture',
    sourceUtf16Length: text.length + secondText.length,
    sourceCodePoints: Array.from(text + secondText).length,
    sourceBytes: 0,
    model: 'fixture-model',
    endpoint: 'fixture-only',
    promptVersion: 'fixture',
    promptSha256: 'fixture',
    chunkLimit: 2400,
    status: 'completed',
    chapters,
    chunks: chapters.map((chapter, index) => ({
      id: `k${index + 1}`,
      chapterId: chapter.id,
      start: chapter.start,
      end: chapter.end,
      status: 'succeeded',
      attempts: [],
      mentions: [],
    })),
    assets: structuredClone(assets),
    probes: [],
    progress: {
      total: 2,
      succeeded: 2,
      running: 0,
      pending: 0,
      failed: 0,
      coveredUtf16: text.length + secondText.length,
      chapters: chapters.map((chapter) => ({ ...chapter, status: 'succeeded' })),
    },
  }
}
class FixtureEvents {
  static active: FixtureEvents[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FixtureEvents.active.push(this)
  }
  close() {
    this.closed = true
  }
  send(project: ProjectView) {
    this.onmessage?.({ data: JSON.stringify(project) })
  }
}
const originals = new Map<string, PropertyDescriptor | undefined>()
let host: HTMLElement
let root: Root
let createRoot: typeof import('react-dom/client').createRoot
let current = fixture()
let sourceFails = false
let delayedChapter: Promise<Response> | null = null
let analyzeFails = true
let calls: { url: string; method: string; body?: string }[] = []
const setGlobal = (name: string, value: unknown) => {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
beforeAll(async () => {
  const dom = parseHTML('<!doctype html><html><body></body></html>')
  setGlobal('window', dom.window)
  setGlobal('document', dom.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('Event', dom.window.Event)
  setGlobal('EventSource', FixtureEvents)
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  dom.window.HTMLElement.prototype.scrollTo = () => {}
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
})
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  host?.remove()
})
afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})
async function mount(project = fixture()) {
  current = project
  sourceFails = false
  delayedChapter = null
  analyzeFails = true
  calls = []
  FixtureEvents.active = []
  setGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    if (url.endsWith('/analyze'))
      return Response.json(analyzeFails ? { error: 'fixture 提取失败' } : { accepted: true }, {
        status: analyzeFails ? 503 : 202,
      })
    if (url.endsWith('/chapters/c1') && delayedChapter) return delayedChapter
    if (url.endsWith('/chapters/c1'))
      return new Response(sourceFails ? 'failed' : text, { status: sourceFails ? 500 : 200 })
    if (url.endsWith('/chapters/c2')) return new Response(secondText)
    if (url === '/api/ip-video/projects')
      return Response.json([
        {
          id: current.id,
          title: current.title,
          status: current.status,
          updatedAt: current.updatedAt,
        },
      ])
    return Response.json(current)
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<IPVideoLive onDemo={() => {}} />)
  })
}
function button(text: string) {
  const match = [...host.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  )
  if (!match) throw new Error(`Button not found: ${text}`)
  return match
}
async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new Event('click', { bubbles: true }))
  })
}
async function nav(name: string) {
  const item = [...host.querySelectorAll('.ip-nav-button')].find(
    (item) => item.getAttribute('title') === name,
  )
  if (!item) throw new Error(`Navigation missing: ${name}`)
  await click(item)
}

describe('IP video real workspace DOM (fixture transport, not browser visual acceptance)', () => {
  test('HTTP snapshot loads original studio navigation without demo media or automatic writes', async () => {
    await mount()
    expect(host.textContent).toContain('镜界 / Scene Ledger')
    expect(host.textContent).toContain('UI 隔离测试小说')
    expect(host.querySelector('.ip-rail')).not.toBeNull()
    expect(host.querySelector('video, img')).toBeNull()
    expect(host.textContent).not.toContain('gen_demo_001')
    expect(button('分析已完成').hasAttribute('disabled')).toBe(true)
    expect(host.querySelector('[title="分镜工作台未接入"]')?.hasAttribute('disabled')).toBe(true)
    expect(host.querySelector('[title="生成任务未接入"]')?.hasAttribute('disabled')).toBe(true)
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
  test('chapter full text and exact cross-chapter evidence survive view navigation', async () => {
    await mount()
    await nav('资料库')
    expect(host.querySelector('[data-testid="chapter-full-text"]')?.textContent).toBe(text)
    await nav('资产库')
    const sourceButton = [...host.querySelectorAll('.ip-live-evidence button')][0]
    expect(sourceButton).toBeDefined()
    await click(sourceButton)
    expect(host.querySelector('[data-testid="chapter-full-text"]')?.textContent).toBe(secondText)
    expect(host.querySelector('mark')?.textContent).toBe('陈实离开庭院。')
    expect(host.querySelector('.ip-chapter-button.is-active')?.textContent).toContain('第2章')
  })
  test('cards paginate, filter by type and keep full descriptions and evidence collapsed', async () => {
    await mount()
    await nav('资产库')
    expect(host.querySelectorAll('.ip-asset-card')).toHaveLength(12)
    expect(host.querySelector('.ip-asset-body')?.textContent).not.toContain('必须折叠')
    expect(host.querySelector('.ip-live-description')?.hasAttribute('open')).toBe(false)
    expect(host.querySelector('.ip-live-evidence details')?.hasAttribute('open')).toBe(false)
    await click(button('下一页'))
    expect(host.querySelectorAll('.ip-asset-card')).toHaveLength(4)
    expect(host.querySelector('[aria-label="资产详情"] h3')?.textContent).toBe('人物12')
    const location = [...host.querySelectorAll('.ip-tab')].find((item) =>
      item.textContent?.startsWith('场景'),
    )
    if (!location) throw new Error('Location filter missing')
    await click(location)
    expect(host.querySelectorAll('.ip-asset-card')).toHaveLength(1)
    expect(host.querySelector('[aria-label="资产详情"] h3')?.textContent).toBe('庭院')
    expect(button('生成参考图 · 未接入').hasAttribute('disabled')).toBe(true)
  })
  test('creation category is one card with separate identity details and exact source navigation', async () => {
    const p = fixture()
    p.assets = p.assets.slice(0, 2)
    p.categoryGroups = [
      {
        id: 'category-fixture',
        label: '同类道具',
        memberIds: p.assets.map((a) => a.id),
        correctionId: 'review-fixture',
      },
    ]
    await mount(p)
    await nav('资产库')
    expect(host.querySelectorAll('.ip-asset-card')).toHaveLength(1)
    expect(host.querySelector('[aria-label="资产详情"] h3')?.textContent).toBe('同类道具')
    expect(host.textContent).toContain('人物0 · 1 条引用')
    expect(host.textContent).toContain('人物1 · 1 条引用')
    expect(host.textContent).toContain('人物1的首条描述。')
    const quoteButton = [...host.querySelectorAll('.ip-asset-detail-copy details button')][0]
    await click(quoteButton)
    expect(host.querySelector('mark')?.textContent).toBe('陈实离开庭院。')
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })
  test('SSE merge preserves selected canonical ID and does not double-count aliases', async () => {
    await mount()
    await nav('资产库')
    await click(host.querySelectorAll('.ip-asset-card')[1])
    const merged = fixture()
    merged.assets = [
      { ...merged.assets[0], aliases: ['人物1', '别名1'] },
      ...merged.assets.slice(2),
    ]
    merged.identityResolution = {
      version: 'character-alias-v1',
      confirmations: [],
      decisions: [],
      redirects: { 'person-1': 'person-0' },
    }
    await act(async () => FixtureEvents.active.at(-1)?.send(merged))
    expect(host.querySelector('[aria-label="资产详情"] h3')?.textContent).toBe('人物0')
    expect(host.querySelector('.ip-live-aliases')?.textContent).toContain('人物1')
    expect(host.querySelectorAll('.ip-asset-card')).toHaveLength(12)
    expect(host.querySelector('.ip-live-pagination')?.textContent).toContain('共 15 项')
  })
  test('failed analyze stays failed across SSE updates and preserves retry request contract', async () => {
    const project = fixture()
    project.status = 'failed'
    project.error = '失败块等待重试'
    await mount(project)
    await click(button('继续 / 重试失败'))
    expect(host.textContent).toContain('fixture 提取失败')
    const writes = calls.filter((call) => call.method === 'POST')
    expect(writes).toHaveLength(1)
    expect(writes[0].url).toBe('/api/ip-video/projects/fixture-project/analyze')
    expect(JSON.parse(writes[0].body ?? '')).toEqual({ retryFailed: true, concurrency: 6 })
    await act(async () => FixtureEvents.active.at(-1)?.send(project))
    expect(host.textContent).toContain('fixture 提取失败')
    expect(button('继续 / 重试失败').hasAttribute('disabled')).toBe(false)
  })
  test('SSE disconnection leaves snapshot readable and refresh sends only GET requests', async () => {
    await mount()
    await act(async () => FixtureEvents.active.at(-1)?.onerror?.())
    expect(host.textContent).toContain('实时进度断开')
    expect(host.textContent).toContain('UI 隔离测试小说')
    await click(button('刷新结果'))
    expect(FixtureEvents.active[0].closed).toBe(true)
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
  test('100% extraction with running identity resolution is not completed or retryable', async () => {
    const project = fixture()
    project.status = 'running'
    project.identityResolution = {
      version: 'character-alias-v1',
      confirmations: [],
      decisions: [],
      redirects: {},
      ai: {
        version: 'ai-entity-v1',
        snapshot: 'fixture',
        subjectIds: ['person-0'],
        status: 'running',
        attempts: [],
        decisions: [],
      },
    }
    await mount(project)
    expect(host.querySelector('progress')?.getAttribute('value')).toBe(
      String(project.sourceUtf16Length),
    )
    expect(host.textContent).toContain('身份复核：处理中')
    expect(button('正在分析').hasAttribute('disabled')).toBe(true)
    expect(host.textContent).not.toContain('分析已完成')
  })
  test('chapter read errors remain visible and an explicit retry restores the entire text', async () => {
    await mount()
    await nav('资料库')
    await click(host.querySelectorAll('.ip-chapter-button')[1])
    sourceFails = true
    await click(host.querySelectorAll('.ip-chapter-button')[0])
    expect(host.textContent).toContain('章节读取失败：HTTP 500')
    expect(host.querySelector('[data-testid="chapter-full-text"]')).toBeNull()
    sourceFails = false
    await click(button('重试读取章节'))
    expect(host.querySelector('[data-testid="chapter-full-text"]')?.textContent).toBe(text)
  })
  test('late chapter response cannot replace the newly selected chapter', async () => {
    await mount()
    await nav('资料库')
    await click(host.querySelectorAll('.ip-chapter-button')[1])
    let finish: (response: Response) => void = () => {
      throw new Error('Deferred request not initialized')
    }
    delayedChapter = new Promise<Response>((resolve) => {
      finish = resolve
    })
    await click(host.querySelectorAll('.ip-chapter-button')[0])
    await click(host.querySelectorAll('.ip-chapter-button')[1])
    await act(async () => finish(new Response(text)))
    expect(host.querySelector('[data-testid="chapter-full-text"]')?.textContent).toBe(secondText)
  })
  test('demo requires explicit entry, labels mock results, and removes media on return', async () => {
    await mount()
    await act(async () => root.render(<IPVideoPage />))
    expect(host.querySelector('video')).toBeNull()
    await click(button('独立演示'))
    expect(host.querySelector('.ip-demo-banner')?.textContent).toContain('预置资产与模拟生成任务')
    expect(host.querySelector('video')).not.toBeNull()
    await click(button('返回真实分析'))
    expect(host.querySelector('.ip-demo-banner')).toBeNull()
    expect(host.querySelector('video')).toBeNull()
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
})
