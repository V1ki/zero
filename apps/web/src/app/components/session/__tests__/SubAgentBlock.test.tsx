import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubAgentBlock } from '../SubAgentBlock'

describe('SubAgentBlock', () => {
  test('renders the full sub-agent internal timeline inline when expanded', () => {
    const html = renderToStaticMarkup(
      <SubAgentBlock
        agentId="agent_worker_1"
        label="Worker 1"
        agentRole="explorer"
        model="anthropic/claude-opus-4-6"
        instruction="Trace the missing task closure signal and verify where the classifier branch is emitted."
        status="completed"
        output="Found the classifier branch in the trace tree and confirmed the missing emission path."
        durationMs={1280}
        createdAt="2026-04-19T10:00:00.000Z"
        childToolCalls={[
          {
            id: 'child_read',
            name: 'read',
            input: { path: 'apps/web/src/api/routes.ts' },
            durationMs: 180,
          },
          {
            id: 'child_bash',
            name: 'bash',
            input: { command: 'rg task_closure apps/web/src' },
            durationMs: 420,
          },
        ]}
        traceSpan={{
          id: 'span_sub_agent',
          sessionId: 'sess_1',
          name: 'sub_agent',
          startTime: '2026-04-19T10:00:00.000Z',
          durationMs: 1280,
          status: 'success',
          metadata: { agentId: 'agent_worker_1' },
          data: { kind: 'sub_agent', outputSummary: 'Found the classifier branch.' },
          children: [
            {
              id: 'span_turn',
              parentId: 'span_sub_agent',
              sessionId: 'sess_1',
              name: 'turn:worker-1',
              startTime: '2026-04-19T10:00:00.100Z',
              durationMs: 80,
              status: 'success',
              data: { goal: 'Trace the missing task closure signal' },
              children: [
                {
                  id: 'span_request',
                  parentId: 'span_turn',
                  sessionId: 'sess_1',
                  name: 'llm_request',
                  startTime: '2026-04-19T10:00:00.180Z',
                  durationMs: 220,
                  status: 'success',
                  metadata: { model: 'anthropic/claude-opus-4-6' },
                  data: {
                    userPrompt: 'Inspect the classifier path',
                    responseSummary: 'Use read and bash to verify the trace path.',
                    inputTokens: 340,
                    outputTokens: 91,
                    stopReason: 'tool_use',
                  },
                  children: [
                    {
                      id: 'span_read',
                      parentId: 'span_request',
                      sessionId: 'sess_1',
                      name: 'tool:read',
                      startTime: '2026-04-19T10:00:00.250Z',
                      durationMs: 180,
                      status: 'success',
                      metadata: {
                        toolUseId: 'child_read',
                        input: { path: 'apps/web/src/api/routes.ts' },
                        outputSummary: 'Read routes file',
                      },
                      children: [],
                    },
                    {
                      id: 'span_bash',
                      parentId: 'span_request',
                      sessionId: 'sess_1',
                      name: 'tool:bash',
                      startTime: '2026-04-19T10:00:00.460Z',
                      durationMs: 420,
                      status: 'success',
                      metadata: {
                        toolUseId: 'child_bash',
                        input: { command: 'rg task_closure apps/web/src' },
                        result: 'apps/web/src/app/components/session/ContextPanel.tsx:734',
                      },
                      children: [],
                    },
                  ],
                },
              ],
            },
            {
              id: 'span_reason',
              parentId: 'span_sub_agent',
              sessionId: 'sess_1',
              name: 'agent.reason',
              startTime: '2026-04-19T10:00:00.420Z',
              durationMs: 120,
              status: 'success',
              data: { note: 'planning next step' },
              children: [],
            },
          ],
        }}
        selected
        selectedChildToolId="child_read"
        onSelect={() => {}}
        onSelectChildTool={() => {}}
      />,
    )

    expect(html).toContain('sub-agent')
    expect(html).toContain('Worker 1')
    expect(html).toContain('explorer')
    expect(html).toContain('anthropic/claude-opus-4-6')
    expect(html).toContain('Mission')
    expect(html).toContain('Activity')
    expect(html).toContain('Internal Timeline (5)')
    expect(html).toContain('turn:worker-1')
    expect(html).toContain('llm_request')
    expect(html).toContain('agent.reason')
    expect(html).toContain('Final Output')
    expect(html).toContain('read')
    expect(html).toContain('bash')
    expect(html).toContain('apps/web/src/api/routes.ts')
    expect(html).toContain(
      'Found the classifier branch in the trace tree and confirmed the missing emission path.',
    )
  })

  test('renders long JSON output as a compact preview', () => {
    const html = renderToStaticMarkup(
      <SubAgentBlock
        agentId="agent_json_1"
        label="think-test1-complex-json"
        model="deepseek/deepseek-v4-pro"
        instruction="Return only JSON."
        status="completed"
        output={JSON.stringify({
          endpoints: [
            { method: 'POST', path: '/api/v1/agents' },
            { method: 'GET', path: '/api/v1/agents' },
            { method: 'DELETE', path: '/api/v1/agents/{id}' },
          ],
        })}
      />,
    )

    expect(html).toContain('deepseek/deepseek-v4-pro')
    expect(html).toContain('JSON output: endpoints[3]')
    expect(html).not.toContain('/api/v1/agents/{id}')
  })
})
