import { type Response, test as base, expect } from '@playwright/test'

type E2EFixtures = {
  createdWebSessionIds: Set<string>
}

async function captureSessionId(response: Response, target: Set<string>) {
  if (response.request().method() !== 'POST') return

  const url = new URL(response.url())
  if (url.pathname !== '/api/chat') return
  if (!response.ok()) return

  const contentType = response.headers()['content-type'] ?? ''
  if (!contentType.includes('application/json')) return

  const payload = (await response.json().catch(() => null)) as { sessionId?: unknown } | null
  if (typeof payload?.sessionId === 'string') {
    target.add(payload.sessionId)
  }
}

export const test = base.extend<E2EFixtures>({
  createdWebSessionIds: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object destructuring pattern for fixture args
    async ({}, use) => {
      await use(new Set<string>())
    },
    { auto: true },
  ],
  page: async ({ page, createdWebSessionIds }, use) => {
    const handleResponse = (response: Response) => {
      void captureSessionId(response, createdWebSessionIds)
    }

    page.on('response', handleResponse)
    try {
      await use(page)
    } finally {
      page.off('response', handleResponse)
    }
  },
})

test.afterEach(async ({ request, createdWebSessionIds }) => {
  for (const sessionId of createdWebSessionIds) {
    const response = await request.delete(`/api/sessions/${sessionId}`).catch(() => null)
    if (!response || response.ok() || response.status() === 404) continue
    console.warn(`[e2e] failed to delete test web session ${sessionId}: ${response.status()}`)
  }
  createdWebSessionIds.clear()
})

export { expect }
