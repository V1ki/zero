import { describe, expect, test } from 'bun:test'
import {
  type SourceCard,
  canTransitionSourceCardState,
  sanitizeSourceCardTraceEvidence,
  validateSourceCard,
} from '../types/source-card'

function createDraftCard(overrides: Partial<SourceCard> = {}): SourceCard {
  return {
    schemaVersion: 1,
    id: 'public-source',
    title: 'Public source',
    state: 'draft',
    sensitivity: 'public',
    tags: ['market-data'],
    sourceDoc: {
      format: 'markdown',
      body: '# Public source\n\n## When to use\n- Use for public rows.\n\n## How to use\n- Fetch https://example.invalid/data.',
    },
    source: {
      sessionId: 'sess_20260511_0000_web_abcd',
      traceRefs: ['trace:span_1'],
      summary: 'Public API fetch.',
    },
    ...overrides,
  }
}

describe('Source Card types', () => {
  test('defines the small document-card lifecycle', () => {
    expect(canTransitionSourceCardState('draft', 'active')).toBe(true)
    expect(canTransitionSourceCardState('draft', 'retired')).toBe(true)
    expect(canTransitionSourceCardState('active', 'retired')).toBe(true)
    expect(canTransitionSourceCardState('retired', 'active')).toBe(false)
  })

  test('validates a Markdown Source Card document', () => {
    const result = validateSourceCard(createDraftCard())

    expect(result).toEqual({ ok: true, errors: [] })
  })

  test('rejects invalid ids and missing document bodies', () => {
    const result = validateSourceCard(
      createDraftCard({
        id: '../public-source',
        sourceDoc: {
          format: 'markdown',
          body: '',
        },
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('id must be a lowercase id')
    expect(result.errors.join('\n')).toContain('sourceDoc.body')
  })

  test('rejects source docs with credential references or secret material', () => {
    const result = validateSourceCard(
      createDraftCard({
        sourceDoc: {
          format: 'markdown',
          body: 'Use external:himalaya/account/qq with authorization: Bearer secret-token.',
        },
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('sourceDoc.body')
  })

  test('rejects source evidence metadata with credential references', () => {
    const result = validateSourceCard(
      createDraftCard({
        source: {
          sessionId: 'sess_20260511_0000_web_abcd',
          traceRefs: ['external:himalaya/account/qq'],
          summary: 'authorization=Bearer secret-token',
        },
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('source.traceRefs[0]')
    expect(result.errors.join('\n')).toContain('source.summary')
  })

  test('redacts trace evidence and credential references', () => {
    const evidence = sanitizeSourceCardTraceEvidence({
      credentialRef: 'external:himalaya/account/qq',
      authorization: 'Bearer secret-token',
      headers: {
        cookie: 'sid=secret',
      },
      message: 'token=secret-value',
    })

    expect(evidence).toEqual({
      credentialRef: '[REDACTED]',
      authorization: '[REDACTED]',
      headers: {
        cookie: '[REDACTED]',
      },
      message: 'token=[REDACTED]',
    })
  })
})
