/**
 * Tier 3: JavaScript-Heavy SPA scenarios.
 * Tests client-side rendering, dynamic content loading.
 */

import { estimateTokens } from '../drivers/base'
import type { Scenario } from './index'

export const spaScenarios: Scenario[] = [
  {
    id: 'J1',
    name: 'React SPA — react.dev',
    tier: 'spa',
    url: 'https://react.dev',
    description: 'Navigate to a React SPA, wait for client-side render, and snapshot.',
    expectations: [
      {
        text: 'Page content renders (not empty shell)',
        check: (outputs) => {
          const text = outputs.get('text')
          const content = text?.output ?? ''
          // react.dev should contain "React" after JS rendering
          const hasContent = content.includes('React') && content.length > 200
          return {
            passed: hasContent,
            evidence: hasContent
              ? `Page rendered: ${estimateTokens(content)} tokens, contains "React"`
              : `Content too short (${content.length} chars) or missing "React"`,
          }
        },
      },
      {
        text: 'Snapshot captures interactive elements',
        check: (outputs) => {
          const snap = outputs.get('snapshot')
          const refCount = (snap?.output?.match(/\be\d+\b|@e\d+/g) ?? []).length
          return {
            passed: refCount >= 5,
            evidence: `Found ${refCount} interactive elements`,
          }
        },
      },
      {
        text: 'Navigation links are present',
        check: (outputs) => {
          const snap = outputs.get('snapshot')
          const output = snap?.output?.toLowerCase() ?? ''
          const hasLinks =
            output.includes('link') || output.includes('learn') || output.includes('reference')
          return {
            passed: hasLinks,
            evidence: hasLinks ? 'Navigation links found' : 'No navigation links detected',
          }
        },
      },
    ],
    run: async (driver) => {
      const outputs = new Map()
      outputs.set('navigate', await driver.navigate('https://react.dev'))
      // Allow time for client-side hydration
      await Bun.sleep(3000)
      outputs.set('snapshot', await driver.snapshot({ interactive: true }))
      outputs.set('text', await driver.text())
      return outputs
    },
  },
]
