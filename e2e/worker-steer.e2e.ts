import { expect, test } from './fixtures'

test('can steer a running Worker and retry a rejected instruction', async ({ page }) => {
  const sessionId = 'sess_worker_steer'
  const api = `/api/sessions/${sessionId}`
  const ts = '2026-11-03T01:00:00.000Z'
  const call = { id: 'work_1', name: 'worker', input: { type: 'codex', instruction: 'Review UI' } }
  const requestId = 'req_1'
  const model = 'openai-codex/gpt-5.4-medium'

  await page.route(`**${api}`, (route) =>
    route.fulfill({
      json: {
        id: sessionId,
        source: 'web',
        isCurrent: true,
        placement: 'current',
        currentModel: model,
        createdAt: ts,
        updatedAt: ts,
        tags: [],
        modelHistory: [],
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        effectiveInputTokens: 0,
        cacheHitRate: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        grossAvoidedInputCost: 0,
        netSavings: 0,
        totalCost: 0,
        requestCount: 1,
        messages: [
          {
            id: 'u1',
            role: 'user',
            messageType: 'message',
            createdAt: ts,
            content: [{ type: 'text', text: 'Delegate a review' }],
          },
          {
            id: 'a1',
            role: 'assistant',
            messageType: 'message',
            createdAt: ts,
            content: [{ type: 'tool_use', ...call }],
          },
        ],
      },
    }),
  )
  await page.route(`**${api}/requests`, (route) =>
    route.fulfill({
      json: {
        requests: [
          {
            id: requestId,
            model,
            provider: 'openai-codex',
            ts,
            turnIndex: 1,
            userPrompt: 'Delegate a review',
            response: '',
            stopReason: 'tool_use',
            toolUseCount: 1,
            toolCalls: [call],
            tokens: { input: 0, output: 0 },
            cost: 0,
          },
        ],
      },
    }),
  )
  await page.route(`**${api}/traces`, (route) =>
    route.fulfill({
      json: {
        traces: [
          {
            id: 'span_1',
            sessionId,
            name: 'tool:worker',
            kind: 'tool_call',
            status: 'running',
            startTime: ts,
            children: [],
            data: { tool: 'worker', toolUseId: call.id, requestId },
          },
        ],
      },
    }),
  )
  for (const [path, key] of [
    ['task-closure-events', 'events'],
    ['decisions', 'decisions'],
    ['llm-judge', 'history'],
  ]) {
    await page.route(`**${api}/${path}`, (route) => route.fulfill({ json: { [key]: [] } }))
  }

  const attempts: unknown[] = []
  let accept: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    accept = resolve
  })
  await page.route(`**${api}/tool-calls/${call.id}/steer`, async (route) => {
    expect(route.request().method()).toBe('POST')
    attempts.push(route.request().postDataJSON())
    if (attempts.length === 1) {
      await route.fulfill({ status: 409, json: { error: 'Codex declined the instruction' } })
      return
    }
    await pending
    await route.fulfill({ json: { ok: true } })
  })

  await page.goto(`/sessions/${sessionId}`)
  await page.locator('tr[data-kind="tool"][data-running="true"]').click()
  await expect(page.getByRole('textbox', { name: 'Worker instruction' })).toBeVisible()
  await page.getByRole('tab', { name: 'Timeline' }).click()
  const card = page.locator(`[data-tool-call-id="${call.id}"]`)
  await card.getByRole('button', { name: /worker/i }).click()
  const field = card.getByRole('textbox', { name: 'Worker instruction' })
  const send = card.getByRole('button', { name: 'Send instruction' })
  const instruction = 'Only review keyboard accessibility'
  await expect(send).toBeDisabled()
  await field.fill(instruction)
  await send.click()
  await expect(card.getByRole('status')).toContainText('Codex declined the instruction')
  await expect(field).toHaveValue(instruction)
  await send.click()
  try {
    await expect(card.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    await expect(field).toBeDisabled()
  } finally {
    accept()
  }
  await expect(card.getByRole('status')).toHaveText('Instruction accepted by Worker')
  await expect(field).toHaveValue('')
  await expect(send).toBeDisabled()
  expect(attempts).toEqual([{ instruction }, { instruction }])
})
