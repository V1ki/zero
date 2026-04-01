/**
 * Tier 1: Static Content Extraction scenarios.
 * Tests basic navigation, snapshot, and text extraction capabilities.
 */

import { estimateTokens } from '../drivers/base'
import type { Scenario } from './index'

export const staticScenarios: Scenario[] = [
  {
    id: 'S1',
    name: 'Static Page — example.com',
    tier: 'static',
    url: 'https://example.com',
    description: 'Navigate to a simple static page, snapshot it, and extract text.',
    expectations: [
      {
        text: 'Page loads successfully',
        check: (outputs) => {
          const nav = outputs.get('navigate')
          return {
            passed: nav?.success === true,
            evidence: nav?.success ? 'Navigation succeeded' : `Failed: ${nav?.error}`,
          }
        },
      },
      {
        text: 'Snapshot contains "Example Domain"',
        check: (outputs) => {
          const snap = outputs.get('snapshot')
          const found = snap?.output?.includes('Example Domain') ?? false
          return {
            passed: found,
            evidence: found ? 'Found "Example Domain" in snapshot' : 'Not found in snapshot',
          }
        },
      },
      {
        text: 'Snapshot tokens < 1000',
        check: (outputs) => {
          const snap = outputs.get('snapshot')
          const tokens = estimateTokens(snap?.output ?? '')
          return {
            passed: tokens < 1000,
            evidence: `Snapshot: ${tokens} tokens`,
          }
        },
      },
    ],
    run: async (driver) => {
      const outputs = new Map()
      outputs.set('navigate', await driver.navigate('https://example.com'))
      outputs.set('snapshot', await driver.snapshot({ interactive: true }))
      outputs.set('text', await driver.text())
      return outputs
    },
  },

  {
    id: 'S2',
    name: 'Content-Rich Page — Wikipedia',
    tier: 'static',
    url: 'https://en.wikipedia.org/wiki/TypeScript',
    description:
      'Snapshot a content-rich Wikipedia article. Compare full vs interactive snapshot sizes.',
    expectations: [
      {
        text: 'Full snapshot contains at least 20 elements',
        check: (outputs) => {
          const full = outputs.get('snapshot_full')
          // Count element references (eN pattern for pinchtab, @eN for agent-browser)
          const refMatches = full?.output?.match(/\be\d+\b|@e\d+/g) ?? []
          return {
            passed: refMatches.length >= 20,
            evidence: `Found ${refMatches.length} element refs in full snapshot`,
          }
        },
      },
      {
        text: 'Interactive snapshot is at least 50% smaller than full',
        check: (outputs) => {
          const full = outputs.get('snapshot_full')
          const interactive = outputs.get('snapshot_interactive')
          const fullTokens = estimateTokens(full?.output ?? '')
          const interactiveTokens = estimateTokens(interactive?.output ?? '')
          const ratio = fullTokens > 0 ? interactiveTokens / fullTokens : 1
          return {
            passed: ratio <= 0.5,
            evidence: `Full: ${fullTokens} tokens, Interactive: ${interactiveTokens} tokens (ratio: ${(ratio * 100).toFixed(0)}%)`,
          }
        },
      },
      {
        text: 'Content includes "TypeScript"',
        check: (outputs) => {
          const text = outputs.get('text')
          const found = text?.output?.includes('TypeScript') ?? false
          return {
            passed: found,
            evidence: found ? 'Found "TypeScript" in text output' : 'Not found',
          }
        },
      },
    ],
    run: async (driver) => {
      const outputs = new Map()
      outputs.set('navigate', await driver.navigate('https://en.wikipedia.org/wiki/TypeScript'))
      outputs.set('snapshot_full', await driver.snapshot())
      outputs.set('snapshot_interactive', await driver.snapshot({ interactive: true }))
      outputs.set('text', await driver.text())
      return outputs
    },
  },

  {
    id: 'S3',
    name: 'News List — Hacker News',
    tier: 'static',
    url: 'https://news.ycombinator.com',
    description: 'Extract text from a news listing page. Compare token efficiency.',
    expectations: [
      {
        text: 'Text output contains at least 10 story titles',
        check: (outputs) => {
          const text = outputs.get('text')
          // HN stories have numbered titles; count lines with substance
          const lines = (text?.output ?? '').split('\n').filter((l) => l.trim().length > 10)
          return {
            passed: lines.length >= 10,
            evidence: `Found ${lines.length} substantial text lines`,
          }
        },
      },
      {
        text: 'Text tokens < 2000',
        check: (outputs) => {
          const text = outputs.get('text')
          const tokens = estimateTokens(text?.output ?? '')
          return {
            passed: tokens < 2000,
            evidence: `Text: ${tokens} tokens`,
          }
        },
      },
      {
        text: 'No HTML tags in text output',
        check: (outputs) => {
          const text = outputs.get('text')
          const hasHTML = /<[a-z][\s\S]*>/i.test(text?.output ?? '')
          return {
            passed: !hasHTML,
            evidence: hasHTML ? 'HTML tags found in text output' : 'Clean text, no HTML tags',
          }
        },
      },
    ],
    run: async (driver) => {
      const outputs = new Map()
      outputs.set('navigate', await driver.navigate('https://news.ycombinator.com'))
      outputs.set('text', await driver.text())
      outputs.set('snapshot', await driver.snapshot({ interactive: true }))
      return outputs
    },
  },
]
