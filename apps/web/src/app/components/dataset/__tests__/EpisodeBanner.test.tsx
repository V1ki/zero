import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { EpisodeBanner } from '../EpisodeBanner'

describe('EpisodeBanner', () => {
  test('renders traits, latest evaluation, and recorded context summary', () => {
    const html = renderToStaticMarkup(
      <EpisodeBanner
        episode={{
          sessionId: 'sess_banner_1',
          metadata: {
            source: 'web',
            status: 'completed',
            currentModel: 'chatgpt/gpt-5.4',
          },
          recordedContext: {
            systemPrompt: 'system prompt',
            tools: ['read', 'bash'],
            toolsSource: 'snapshot',
            identityMemory: 'You are ZeRo',
          },
          evaluations: [
            {
              overallScore: 88,
              verdict: 'strong',
              confidence: 'high',
              createdAt: '2026-04-08T10:00:00.000Z',
            },
          ],
          traits: ['uses-tools', 'multi-turn'],
        }}
      />,
    )

    expect(html).toContain('Traits')
    expect(html).toContain('uses-tools')
    expect(html).toContain('Score: 88/100')
    expect(html).toContain('Verdict: STRONG')
    expect(html).toContain('Tools: 2 recorded (snapshot)')
    expect(html).toContain('SystemPrompt: present')
    expect(html).toContain('Identity: present')
  })
})
