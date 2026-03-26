import { expect, test } from './fixtures'

test.describe('Session Detail Decisions', () => {
  const sessionId = 'sess_decision_demo'

  async function mockDecisionSession(page: import('@playwright/test').Page) {
    const sessionResponse = {
      id: sessionId,
      source: 'web',
      status: 'completed',
      currentModel: 'openai-codex/gpt-5.4-medium',
      createdAt: '2026-03-24T10:00:00.000Z',
      updatedAt: '2026-03-24T10:00:05.000Z',
      messages: [
        {
          id: 'msg_user_1',
          role: 'user',
          messageType: 'message',
          content: [{ type: 'text', text: 'Check the deployment state and explain the result' }],
          createdAt: '2026-03-24T10:00:00.000Z',
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          messageType: 'message',
          content: [
            { type: 'text', text: 'I compressed context, retrieved history, and picked tools.' },
          ],
          model: 'openai-codex/gpt-5.4-medium',
          createdAt: '2026-03-24T10:00:02.000Z',
        },
      ],
      tags: [],
      summary: 'Deployment diagnosis session',
      modelHistory: [
        {
          model: 'openai-codex/gpt-5.4-medium',
          from: '2026-03-24T10:00:00.000Z',
          to: null,
        },
      ],
      totalTokens: 321,
      inputTokens: 120,
      outputTokens: 201,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      effectiveInputTokens: 120,
      cacheHitRate: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      grossAvoidedInputCost: 0,
      netSavings: 0,
      totalCost: 0.042,
      requestCount: 1,
    }

    const decisionResponse = {
      decisions: [
        {
          id: 'decision_compress',
          ts: '2026-03-24T10:00:00.900Z',
          decisionType: 'context_compression',
          outcome: 'compress',
          context: {
            currentTokens: 18000,
            conversationBudget: 16000,
          },
          detail: {
            messagesBefore: 20,
            messagesAfter: 11,
            compressedRange: '4-17',
          },
          sourceKind: 'snapshot',
          durationMs: 420,
        },
        {
          id: 'decision_memory',
          ts: '2026-03-24T10:00:01.200Z',
          decisionType: 'memory_retrieval',
          outcome: 'retrieve',
          detail: {
            need: true,
            queries: ['deployment rollback', 'service recovery'],
            searchResultCount: 3,
            selectedMemoryIds: ['mem_1', 'mem_2'],
          },
          sourceKind: 'llm_request',
          durationMs: 280,
        },
        {
          id: 'decision_tools',
          ts: '2026-03-24T10:00:02.100Z',
          decisionType: 'tool_selection',
          outcome: 'read, bash',
          detail: {
            selectedTools: ['read', 'bash'],
            toolCount: 2,
          },
          rationale: 'Inspect the deployment manifest first, then verify service state in shell.',
          sourceKind: 'llm_request',
          durationMs: 860,
        },
      ],
    }

    await page.route(
      new RegExp(
        `/api/sessions/${sessionId}(?:/traces|/task-closure-events|/requests|/decisions|/llm-judge)?$`,
      ),
      async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue()
          return
        }

        const { pathname } = new URL(route.request().url())

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
            body: JSON.stringify(decisionResponse),
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

  test('renders decision cards, opens detail view, and shows persisted decisions in Trace tab', async ({
    page,
  }) => {
    await mockDecisionSession(page)
    await page.goto(`/sessions/${sessionId}`)

    await expect(page.locator('main')).toContainText(sessionId)

    const compressionCard = page.locator('[data-decision-id="decision_compress"]')
    const memoryCard = page.locator('[data-decision-id="decision_memory"]')
    const toolCard = page.locator('[data-decision-id="decision_tools"]')

    await expect(compressionCard).toBeVisible()
    await expect(compressionCard).toContainText('context_compression')
    await expect(memoryCard).toContainText('memory_retrieval')
    await expect(toolCard).toContainText('tool_selection')
    await expect(toolCard).toContainText('read | bash')

    await toolCard.click()
    await expect(page.locator('main')).toContainText('Decision Detail')
    await expect(page.locator('main')).toContainText('DECISION TYPE')
    await expect(page.locator('main')).toContainText('tool_selection')
    await expect(page.locator('main')).toContainText('SOURCE KIND')
    await expect(page.locator('main')).toContainText('llm_request')
    await expect(page.locator('main')).toContainText('RATIONALE')
    await expect(page.locator('main')).toContainText(
      'Inspect the deployment manifest first, then verify service state in shell.',
    )

    await page.keyboard.press('Escape')
    await expect(page.locator('main')).not.toContainText('Decision Detail')
    await expect(page.locator('main')).toContainText('Summary')

    await page.getByRole('button', { name: 'Trace' }).click()
    await expect(page.locator('main')).toContainText('DECISIONS')
    await expect(page.locator('main')).toContainText('context_compression')
    await expect(page.locator('main')).toContainText('tool_selection')
    await expect(page.locator('main')).toContainText('Decision Details')
  })

  test('keeps decision detail readable on narrow viewports without horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockDecisionSession(page)
    await page.goto(`/sessions/${sessionId}`)

    const memoryCard = page.locator('[data-decision-id="decision_memory"]')
    await expect(memoryCard).toBeVisible()

    await memoryCard.click()
    await expect(page.locator('main')).toContainText('Decision Detail')
    await expect(page.locator('main')).toContainText('memory_retrieval')
    await expect(page.locator('main')).toContainText('deployment rollback')

    const layout = await page.evaluate(() => ({
      canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }))
    expect(layout.canScrollX).toBe(false)

    const decisionCardBox = await memoryCard.boundingBox()
    const detailHeaderBox = await page.getByText('Decision Detail').boundingBox()

    expect(decisionCardBox).not.toBeNull()
    expect(detailHeaderBox).not.toBeNull()
    expect(detailHeaderBox?.y ?? 0).toBeGreaterThan(
      (decisionCardBox?.y ?? 0) + (decisionCardBox?.height ?? 0),
    )
  })
})
