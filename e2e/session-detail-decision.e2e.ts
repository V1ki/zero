import { expect, test } from './fixtures'

test.describe('Session Detail Decisions', () => {
  const sessionId = 'sess_decision_demo'

  async function mockDecisionSession(page: import('@playwright/test').Page) {
    const sessionResponse = {
      id: sessionId,
      source: 'web',
      isCurrent: false,
      placement: 'background',
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
          id: 'msg_memory_inject',
          role: 'user',
          messageType: 'notification',
          content: [
            {
              type: 'text',
              text: '<memory_inject layer="layer2"><memory_hint>retry with browser</memory_hint></memory_inject>',
            },
          ],
          createdAt: '2026-03-24T10:00:01.500Z',
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
        {
          id: 'msg_subagent_spawn',
          role: 'assistant',
          messageType: 'message',
          content: [
            {
              type: 'tool_use',
              id: 'call_spawn_worker',
              name: 'spawn_agent',
              input: {
                label: 'Worker 1',
                role: 'explorer',
                instruction: 'Trace the missing task closure signal and verify the classifier path',
              },
            },
          ],
          model: 'openai-codex/gpt-5.4-medium',
          createdAt: '2026-03-24T10:00:02.050Z',
        },
        {
          id: 'msg_subagent_spawn_result',
          role: 'user',
          messageType: 'message',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'call_spawn_worker',
              content: '{"agentId":"agent_worker_1"}',
            },
          ],
          createdAt: '2026-03-24T10:00:02.080Z',
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
          outcome: 'injected',
          detail: {
            need: true,
            layer: 'layer2',
            turnIndex: 1,
            queries: ['deployment rollback', 'service recovery'],
            searchResultCount: 3,
            selectedMemoryIds: ['mem_1', 'mem_2'],
            selectedMemories: [
              {
                id: 'mem_1',
                type: 'runbook',
                title: 'Deployment rollback runbook',
                score: 0.91,
              },
            ],
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
            body: JSON.stringify({
              traces: [
                {
                  id: 'span_root',
                  sessionId,
                  name: 'agent.run:main',
                  startTime: '2026-03-24T10:00:00.000Z',
                  status: 'success',
                  children: [
                    {
                      id: 'span_sub_agent',
                      parentId: 'span_root',
                      sessionId,
                      name: 'sub_agent',
                      startTime: '2026-03-24T10:00:02.100Z',
                      endTime: '2026-03-24T10:00:03.380Z',
                      durationMs: 1280,
                      status: 'success',
                      metadata: { agentId: 'agent_worker_1' },
                      data: {
                        kind: 'sub_agent',
                        agentId: 'agent_worker_1',
                        output: 'Found the classifier branch in the trace tree.',
                        durationMs: 1280,
                      },
                      children: [
                        {
                          id: 'span_sub_turn',
                          parentId: 'span_sub_agent',
                          sessionId,
                          name: 'turn:worker-1',
                          startTime: '2026-03-24T10:00:02.150Z',
                          endTime: '2026-03-24T10:00:02.220Z',
                          durationMs: 70,
                          status: 'success',
                          data: {
                            goal: 'Trace the missing task closure signal and verify the classifier path',
                          },
                          children: [
                            {
                              id: 'span_sub_request',
                              parentId: 'span_sub_turn',
                              sessionId,
                              name: 'llm_request',
                              startTime: '2026-03-24T10:00:02.220Z',
                              endTime: '2026-03-24T10:00:02.480Z',
                              durationMs: 260,
                              status: 'success',
                              metadata: {
                                model: 'openai-codex/gpt-5.4-medium',
                              },
                              data: {
                                responseSummary: 'Read the routes file, then grep for the classifier path.',
                                stopReason: 'tool_use',
                                inputTokens: 420,
                                outputTokens: 73,
                              },
                              children: [
                                {
                                  id: 'span_child_read',
                                  parentId: 'span_sub_request',
                                  sessionId,
                                  name: 'tool:read',
                                  startTime: '2026-03-24T10:00:02.250Z',
                                  endTime: '2026-03-24T10:00:02.380Z',
                                  durationMs: 130,
                                  status: 'success',
                                  metadata: {
                                    toolUseId: 'child_call_1',
                                    input: { path: 'apps/web/src/api/routes.ts' },
                                    outputSummary: 'Read routes file',
                                  },
                                  children: [],
                                },
                                {
                                  id: 'span_child_bash',
                                  parentId: 'span_sub_request',
                                  sessionId,
                                  name: 'tool:bash',
                                  startTime: '2026-03-24T10:00:02.500Z',
                                  endTime: '2026-03-24T10:00:02.920Z',
                                  durationMs: 420,
                                  status: 'success',
                                  metadata: {
                                    toolUseId: 'child_call_2',
                                    input: { command: 'rg task_closure apps/web/src' },
                                    result:
                                      'apps/web/src/app/components/session/ContextPanel.tsx:734',
                                  },
                                  children: [],
                                },
                              ],
                            },
                          ],
                        },
                        {
                          id: 'span_child_reason',
                          parentId: 'span_sub_agent',
                          sessionId,
                          name: 'agent.reason',
                          startTime: '2026-03-24T10:00:02.390Z',
                          endTime: '2026-03-24T10:00:02.480Z',
                          durationMs: 90,
                          status: 'success',
                          data: {
                            note: 'planning next trace hop',
                          },
                          children: [],
                        },
                      ],
                    },
                    {
                      id: 'span_memory_nudge',
                      parentId: 'span_root',
                      sessionId,
                      name: 'memory_nudge',
                      startTime: '2026-03-24T10:00:03.600Z',
                      endTime: '2026-03-24T10:00:03.920Z',
                      durationMs: 320,
                      status: 'success',
                      metadata: {
                        purpose: 'memory_nudge',
                        iteration: 3,
                        memoryWritten: true,
                      },
                      data: {
                        memoryNudge: {
                          prompt:
                            '<system_notice>当前阶段已完成。请快速评估：本次交互是否产生了值得跨会话保留的信息？</system_notice>',
                          iteration: 3,
                        },
                      },
                      children: [
                        {
                          id: 'span_memory_search',
                          parentId: 'span_memory_nudge',
                          sessionId,
                          name: 'tool:memory_search',
                          startTime: '2026-03-24T10:00:03.640Z',
                          endTime: '2026-03-24T10:00:03.680Z',
                          durationMs: 40,
                          status: 'success',
                          metadata: {
                            toolUseId: 'memory_search_call_1',
                            toolName: 'memory_search',
                            input: { query: 'deployment rollback runbook' },
                            outputSummary: 'Found 2 relevant memories',
                            result: 'Found 2 relevant memories',
                          },
                          children: [],
                        },
                        {
                          id: 'span_memory_write',
                          parentId: 'span_memory_nudge',
                          sessionId,
                          name: 'tool:memory',
                          startTime: '2026-03-24T10:00:03.760Z',
                          endTime: '2026-03-24T10:00:03.810Z',
                          durationMs: 50,
                          status: 'success',
                          metadata: {
                            toolUseId: 'memory_write_call_1',
                            toolName: 'memory',
                            input: {
                              action: 'create',
                              type: 'runbook',
                              title: 'Deployment rollback checklist',
                              content:
                                '1. Pause rollout\\n2. Restore previous image\\n3. Verify recovery',
                            },
                            outputSummary: 'Created memory: Deployment rollback checklist',
                            result: 'Created memory: Deployment rollback checklist',
                          },
                          children: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
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
            body: JSON.stringify({
              requests: [
                {
                  id: 'req_memory',
                  turnIndex: 1,
                  model: 'openai-codex/gpt-5.4-medium',
                  provider: 'openai',
                  userPrompt: 'Check the deployment state and explain the result',
                  response: 'I retrieved the rollback memory and injected it.',
                  stopReason: 'end_turn',
                  toolUseCount: 0,
                  tokens: { input: 12, output: 7 },
                  cost: 0.0021,
                  ts: '2026-03-24T10:00:01.550Z',
                  memoryInjections: [
                    {
                      layer: 'layer2',
                      source: 'memory_hint',
                      formattedText:
                        '<memory_inject layer="layer2"><memory_hint>retry with browser</memory_hint></memory_inject>',
                    },
                  ],
                },
              ],
            }),
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

        if (pathname === '/api/memory/runbook/mem_1') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              memory: {
                content:
                  '# Deployment rollback runbook\n\n1. Pause rollout\n2. Restore previous image\n3. Verify service recovery',
              },
            }),
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

    await page.route('**/api/memory/runbook/mem_1', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          memory: {
            content:
              '# Deployment rollback runbook\n\n1. Pause rollout\n2. Restore previous image\n3. Verify service recovery',
          },
        }),
      })
    })
  }

  test('renders decision cards, opens detail view, and shows persisted decisions in Trace tab', async ({
    page,
  }) => {
    await mockDecisionSession(page)
    await page.goto(`/sessions/${sessionId}`)

    await expect(page.locator('main')).toContainText(sessionId)

    const compressionCard = page.locator('[data-decision-id="decision_compress"]')
    const memoryCard = page.locator('[data-memory-retrieval-id="decision_memory"]')
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

    await page
      .locator('[data-testid="session-context-panel"]')
      .getByRole('button', { name: 'Trace' })
      .click()
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

    const memoryCard = page.locator('[data-memory-retrieval-id="decision_memory"]')
    await expect(memoryCard).toBeVisible()

    await memoryCard.click()
    await expect(memoryCard).toContainText('Injected Context')
    await memoryCard.getByRole('button', { name: /Expand \(\d+ chars\)/ }).first().click()
    await expect(memoryCard).toContainText('retry with browser')
    await expect(page.locator('main')).not.toContainText('Runtime Warning')
    await expect(page.locator('main')).toContainText('memory_retrieval')
    await expect(page.locator('main')).toContainText('deployment rollback')
    await expect(page.locator('main')).toContainText('memory_nudge')
    await expect(page.locator('[data-testid="session-context-panel"]')).not.toContainText(
      'Memory Retrieval Detail',
    )

    const layout = await page.evaluate(() => ({
      canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }))
    expect(layout.canScrollX).toBe(false)

    const decisionCardBox = await memoryCard.boundingBox()
    const expandedInjectionBox = await memoryCard.getByText('Injected Context').boundingBox()

    expect(decisionCardBox).not.toBeNull()
    expect(expandedInjectionBox).not.toBeNull()
    expect((expandedInjectionBox?.y ?? 0) - (decisionCardBox?.y ?? 0)).toBeGreaterThan(40)
  })

  test('opens selected memory from inline retrieval card without switching the sidebar', async ({
    page,
  }) => {
    await mockDecisionSession(page)
    await page.goto(`/sessions/${sessionId}`)

    const memoryCard = page.locator('[data-memory-retrieval-id="decision_memory"]')
    await memoryCard.locator('button').first().click()

    const memoryEntry = memoryCard.locator('[data-memory-entry-id="mem_1"]')
    await expect(memoryEntry).toBeVisible()
    await memoryEntry.click()

    const dialog = page.getByTestId('memory-detail-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Deployment rollback runbook')
    await expect(dialog).toContainText('Pause rollout')
    await expect(page.locator('[data-testid="session-context-panel"]')).not.toContainText(
      'Memory Retrieval Detail',
    )

    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()
  })

  test('expands memory nudge cards and shows nested memory tool details inline', async ({
    page,
  }) => {
    await mockDecisionSession(page)
    await page.goto(`/sessions/${sessionId}`)

    const memoryNudge = page.locator('[data-memory-nudge-id="memory-nudge-trace-span_memory_nudge"]')
    await expect(memoryNudge).toBeVisible()
    await expect(memoryNudge).toContainText('wrote memory')

    await memoryNudge.locator('button').first().click()
    await expect(memoryNudge).toContainText('Memory Activity')
    await expect(memoryNudge).toContainText('deployment rollback runbook')
    await expect(memoryNudge).toContainText('Deployment rollback checklist')

    const memoryWriteRow = memoryNudge.locator('[data-memory-nudge-tool-id="memory_write_call_1"]')
    await expect(memoryWriteRow).toBeVisible()
    await memoryWriteRow.click()

    await expect(memoryNudge).toContainText('Memory Target')
    await expect(memoryNudge).toContainText('Created memory: Deployment rollback checklist')
    await expect(memoryNudge).toContainText('1. Pause rollout')
    await expect(page.locator('[data-testid="session-context-panel"]')).not.toContainText(
      'Memory Retrieval Detail',
    )
    await expect(page.locator('[data-testid="session-context-panel"]')).not.toContainText(
      'Sub-agent Detail',
    )
  })

  test('renders sub-agent process inline and keeps the sidebar on summary', async ({ page }) => {
    await mockDecisionSession(page)
    await page.goto(`/sessions/${sessionId}`)

    const subAgentCard = page.locator('[data-sub-agent-id="agent_worker_1"]')
    await expect(subAgentCard).toBeVisible()

    await subAgentCard.getByRole('button', { expanded: false }).click()
    await expect(subAgentCard).toContainText('Mission')
    await expect(subAgentCard).toContainText('Activity')
    await expect(subAgentCard).toContainText('Internal Timeline')
    await expect(subAgentCard).toContainText('turn:worker-1')
    await expect(subAgentCard).toContainText('llm_request')
    await expect(subAgentCard).toContainText('agent.reason')
    await expect(subAgentCard).toContainText('Final Output')
    await expect(subAgentCard).toContainText('Found the classifier branch in the trace tree.')

    const childReadTool = subAgentCard.getByRole('button', { name: /read tool:read/i })
    await expect(childReadTool).toBeVisible()
    await childReadTool.click()
    await expect(subAgentCard).toContainText('apps/web/src/api/routes.ts')
    await expect(page.locator('[data-testid="session-context-panel"]')).not.toContainText(
      'Sub-agent Detail',
    )
  })
})
