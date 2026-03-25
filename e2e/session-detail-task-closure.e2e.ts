import { expect, test } from './fixtures'

test.describe('Session Detail Task Closure', () => {
  const sessionId = 'sess_task_closure_demo'

  async function mockTaskClosureSession(page: import('@playwright/test').Page) {
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
          content: [{ type: 'text', text: 'Check whether the task can be closed' }],
          createdAt: '2026-03-24T10:00:00.000Z',
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          messageType: 'message',
          content: [
            { type: 'text', text: 'I reviewed the latest state and still have follow-up work.' },
            { type: 'tool_use', id: 'tool_1', name: 'read', input: { path: '/tmp/demo.txt' } },
          ],
          model: 'openai-codex/gpt-5.4-medium',
          createdAt: '2026-03-24T10:00:02.000Z',
        },
        {
          id: 'msg_tool_result_1',
          role: 'user',
          messageType: 'message',
          content: [{ type: 'tool_result', toolUseId: 'tool_1', content: 'demo file contents' }],
          createdAt: '2026-03-24T10:00:02.100Z',
        },
      ],
      tags: [],
      modelHistory: [
        {
          model: 'openai-codex/gpt-5.4-medium',
          from: '2026-03-24T10:00:00.000Z',
          to: null,
        },
      ],
      totalTokens: 123,
      inputTokens: 45,
      outputTokens: 78,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      effectiveInputTokens: 45,
      cacheHitRate: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      grossAvoidedInputCost: 0,
      netSavings: 0,
      totalCost: 0.012,
      requestCount: 1,
    }

    const taskClosureResponse = {
      events: [
        {
          ts: '2026-03-24T10:00:03.000Z',
          event: 'task_closure_decision',
          action: 'continue',
          reason: 'Need to verify a remaining edge case before finishing',
          classifierRequest: {
            system: 'strict classifier',
            prompt: '<instruction>decide if the task is complete</instruction>',
            maxTokens: 200,
          },
          classifierResponseRaw: '{"action":"continue","reason":"Need one more verification"}',
          assistantMessageId: 'msg_assistant_1',
          assistantMessageCreatedAt: '2026-03-24T10:00:02.000Z',
        },
      ],
    }

    await page.route(
      new RegExp(
        `/api/sessions/${sessionId}(?:/traces|/task-closure-events|/requests|/llm-judge)?$`,
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
            body: JSON.stringify(taskClosureResponse),
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

  test('supports task closure selection, tool/task mutual exclusion, and Escape reset', async ({
    page,
  }) => {
    await mockTaskClosureSession(page)
    await page.goto(`/sessions/${sessionId}`)

    await expect(page.locator('main')).toContainText(sessionId)

    const taskClosureCard = page.locator('[data-task-closure-id="tc-sess-0"]')
    const toolCallCard = page.locator('[data-tool-call-id="tool_1"]')

    await expect(taskClosureCard).toBeVisible()
    await expect(taskClosureCard).toContainText('task_closure_decision')
    await expect(taskClosureCard).toContainText(
      'Need to verify a remaining edge case before finishing',
    )

    await taskClosureCard.click()
    await expect(page.locator('main')).toContainText('Task Closure Detail')
    await expect(page.locator('main')).toContainText('CLASSIFIER SYSTEM PROMPT')
    await expect(page.locator('main')).toContainText('CLASSIFIER RESPONSE')
    await expect(page.locator('main')).toContainText('Jump to message')

    await taskClosureCard.click()
    await expect(page.locator('main')).not.toContainText('Task Closure Detail')
    await expect(page.locator('main')).toContainText('Summary')

    await taskClosureCard.click()
    await expect(page.locator('main')).toContainText('Task Closure Detail')

    await toolCallCard.click()
    await expect(page.locator('main')).toContainText('Tool Detail')
    await expect(page.locator('main')).not.toContainText('Task Closure Detail')

    await page.keyboard.press('Escape')
    await expect(page.locator('main')).not.toContainText('Tool Detail')
    await expect(page.locator('main')).toContainText('Summary')
  })

  test('stacks detail content on narrow viewports without horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockTaskClosureSession(page)
    await page.goto(`/sessions/${sessionId}`)

    const deleteButton = page.getByRole('button', { name: 'Delete' })
    const archiveButton = page.getByRole('button', { name: 'Archive' })
    const taskClosureCard = page.locator('[data-task-closure-id="tc-sess-0"]')

    await expect(deleteButton).toBeVisible()
    await expect(archiveButton).toBeVisible()
    await expect(taskClosureCard).toBeVisible()

    await taskClosureCard.click()
    await expect(page.locator('main')).toContainText('Task Closure Detail')
    await expect(page.locator('main')).not.toContainText('TRIM FROM')
    await expect(page.locator('main')).not.toContainText('trim_from')

    const layout = await page.evaluate(() => ({
      canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }))
    expect(layout.canScrollX).toBe(false)

    const taskClosureBox = await taskClosureCard.boundingBox()
    const detailHeaderBox = await page.getByText('Task Closure Detail').boundingBox()

    expect(taskClosureBox).not.toBeNull()
    expect(detailHeaderBox).not.toBeNull()
    expect(detailHeaderBox?.y ?? 0).toBeGreaterThan(
      (taskClosureBox?.y ?? 0) + (taskClosureBox?.height ?? 0),
    )
  })
})
