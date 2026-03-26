import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

interface MockMemoryItem {
  id: string
  type: string
  sessionId?: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  status: string
  confidence: number
  tags: string[]
}

function createMemory(overrides: Partial<MockMemoryItem>): MockMemoryItem {
  return {
    id: 'mem_default',
    type: 'note',
    title: 'Default memory',
    content: 'Default content',
    createdAt: '2026-03-24T10:00:00.000Z',
    updatedAt: '2026-03-24T10:05:00.000Z',
    status: 'verified',
    confidence: 0.8,
    tags: [],
    ...overrides,
  }
}

async function mockMemoryApi(page: Page, initialMemories: MockMemoryItem[]) {
  const memories = [...initialMemories]
  let lastPutPath: string | null = null
  let lastDeletePath: string | null = null

  await page.route(/\/api\/memory(?:\/.*)?(?:\?.*)?$/, async (route) => {
    const request = route.request()
    const method = request.method()
    const url = new URL(request.url())

    if (!url.pathname.startsWith('/api/memory')) {
      await route.continue()
      return
    }

    if (method === 'GET' && url.pathname === '/api/memory') {
      const type = url.searchParams.get('type')
      const filteredMemories =
        type && type !== 'all' ? memories.filter((memory) => memory.type === type) : memories

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          memories: filteredMemories,
          type: type ?? 'all',
        }),
      })
      return
    }

    if (method === 'GET' && url.pathname === '/api/memory/search') {
      const query = (url.searchParams.get('q') ?? '').toLowerCase()
      const results = memories.filter((memory) =>
        `${memory.title} ${memory.content}`.toLowerCase().includes(query),
      )

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results, query }),
      })
      return
    }

    const match = url.pathname.match(/^\/api\/memory\/([^/]+)\/([^/]+)$/)
    if (!match) {
      await route.continue()
      return
    }

    const [, type, id] = match
    const memoryIndex = memories.findIndex((memory) => memory.type === type && memory.id === id)

    if (memoryIndex === -1) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Memory not found' }),
      })
      return
    }

    if (method === 'PUT') {
      lastPutPath = url.pathname
      const payload = request.postDataJSON() as { content?: string }
      const updatedMemory = {
        ...memories[memoryIndex],
        content: payload.content ?? memories[memoryIndex].content,
        updatedAt: '2026-03-24T10:10:00.000Z',
      }
      memories[memoryIndex] = updatedMemory

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ memory: updatedMemory }),
      })
      return
    }

    if (method === 'DELETE') {
      lastDeletePath = url.pathname
      memories.splice(memoryIndex, 1)

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
      return
    }

    await route.continue()
  })

  return {
    getLastPutPath: () => lastPutPath,
    getLastDeletePath: () => lastDeletePath,
  }
}

async function mockSessionDetail(page: Page, sessionId: string) {
  const sessionResponse = {
    id: sessionId,
    source: 'web',
    status: 'completed',
    currentModel: 'openai-codex/gpt-5.4-medium',
    createdAt: '2026-03-24T10:00:00.000Z',
    updatedAt: '2026-03-24T10:01:00.000Z',
    messages: [
      {
        id: 'msg_user_1',
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: 'Open the linked session' }],
        createdAt: '2026-03-24T10:00:00.000Z',
      },
    ],
    tags: [],
    summary: 'Linked session summary',
    modelHistory: [
      {
        model: 'openai-codex/gpt-5.4-medium',
        from: '2026-03-24T10:00:00.000Z',
        to: null,
      },
    ],
    totalTokens: 10,
    inputTokens: 5,
    outputTokens: 5,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    effectiveInputTokens: 5,
    cacheHitRate: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    grossAvoidedInputCost: 0,
    netSavings: 0,
    totalCost: 0.001,
    requestCount: 1,
  }

  await page.route(
    new RegExp(
      `/api/sessions/${sessionId}(?:/traces|/task-closure-events|/requests|/decisions|/llm-judge)?$`,
    ),
    async (route) => {
      const request = route.request()
      if (request.method() !== 'GET') {
        await route.continue()
        return
      }

      const { pathname } = new URL(request.url())

      if (pathname === `/api/sessions/${sessionId}`) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(sessionResponse),
        })
        return
      }

      if (pathname === `/api/sessions/${sessionId}/traces`) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ traces: [] }),
        })
        return
      }

      if (pathname === `/api/sessions/${sessionId}/task-closure-events`) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ events: [] }),
        })
        return
      }

      if (pathname === `/api/sessions/${sessionId}/requests`) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ requests: [] }),
        })
        return
      }

      if (pathname === `/api/sessions/${sessionId}/decisions`) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ decisions: [] }),
        })
        return
      }

      if (pathname === `/api/sessions/${sessionId}/llm-judge`) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ history: [] }),
        })
        return
      }

      await route.continue()
    },
  )
}

async function selectMemory(page: Page, title: string) {
  await page.locator('main button.card').filter({ hasText: title }).click()
}

test.describe('Memory Page', () => {
  test('shows memory heading and key filters', async ({ page }) => {
    await page.goto('/memory')

    await expect(page.locator('main h1')).toContainText('Memory')
    const filterArea = page.locator('main .flex.flex-wrap.gap-1\\.5')
    await expect(filterArea.locator('button:has-text("All")')).toBeVisible()
    await expect(filterArea.locator('button:has-text("session")')).toBeVisible()
    await expect(filterArea.locator('button:has-text("inbox")')).toBeVisible()
    await expect(filterArea.locator('button:has-text("preference")')).toBeVisible()
  })

  test('all filter renders inbox and preference memories', async ({ page }) => {
    await mockMemoryApi(page, [
      createMemory({ id: 'mem_inbox', type: 'inbox', title: 'Inbox memory' }),
      createMemory({ id: 'mem_preference', type: 'preference', title: 'Preference memory' }),
      createMemory({ id: 'mem_note', type: 'note', title: 'Note memory' }),
    ])

    await page.goto('/memory')

    const list = page.locator('main button.card')
    await expect(list.filter({ hasText: 'Inbox memory' })).toBeVisible()
    await expect(list.filter({ hasText: 'Preference memory' })).toBeVisible()
  })

  test('editing a memory saves through the typed URL and updates content', async ({ page }) => {
    const api = await mockMemoryApi(page, [
      createMemory({
        id: 'mem_editable',
        type: 'note',
        title: 'Editable memory',
        content: 'Original content',
      }),
    ])

    await page.goto('/memory')
    await selectMemory(page, 'Editable memory')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()

    const textarea = page.locator('main textarea')
    await expect(textarea).toBeVisible()
    await textarea.fill('Updated memory content')
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(page.locator('main')).toContainText('Updated memory content')
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
    expect(api.getLastPutPath()).toBe('/api/memory/note/mem_editable')
  })

  test('delete confirm supports cancel and removes the selected memory on confirm', async ({
    page,
  }) => {
    const api = await mockMemoryApi(page, [
      createMemory({
        id: 'mem_delete',
        type: 'note',
        title: 'Delete me',
        content: 'Delete target',
      }),
    ])

    await page.goto('/memory')
    await selectMemory(page, 'Delete me')

    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByText('Delete memory?')).toBeVisible()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByText('Delete memory?')).toHaveCount(0)
    await expect(page.locator('main')).toContainText('Delete target')

    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click()

    await expect(page.locator('main button.card').filter({ hasText: 'Delete me' })).toHaveCount(0)
    await expect(page.locator('main')).toContainText('Memory Overview')
    expect(api.getLastDeletePath()).toBe('/api/memory/note/mem_delete')
  })

  test('session memories show a session link and navigate to session detail', async ({ page }) => {
    const sessionId = 'sess_memory_link_demo'

    await mockMemoryApi(page, [
      createMemory({
        id: 'mem_note_plain',
        type: 'note',
        title: 'Plain note',
        content: 'No session link here',
      }),
      createMemory({
        id: 'mem_session_link',
        type: 'session',
        sessionId,
        title: 'Session memory',
        content: 'Session summary',
      }),
    ])
    await mockSessionDetail(page, sessionId)

    await page.goto('/memory')

    await selectMemory(page, 'Plain note')
    await expect(page.getByRole('button', { name: 'View Session', exact: true })).toHaveCount(0)

    await selectMemory(page, 'Session memory')
    await expect(page.getByRole('button', { name: 'View Session', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'View Session', exact: true }).click()

    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`))
    await expect(page.locator('main')).toContainText(sessionId)
    await expect(page.locator('main')).toContainText('Linked session summary')
  })
})
