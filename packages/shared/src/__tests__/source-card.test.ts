import { describe, expect, test } from 'bun:test'
import {
  type SourceCard,
  assertValidSourceWatchBinding,
  canTransitionSourceCardState,
  sanitizeSourceCardTraceEvidence,
  validateSourceCard,
  validateSourceWatchBinding,
} from '../types/source-card'

function createActiveCard(): SourceCard {
  return {
    schemaVersion: 1,
    id: 'public-source',
    title: 'Public source',
    state: 'active',
    kind: 'web_api',
    owner: {
      scope: 'system',
    },
    sensitivity: 'public',
    discovery: {
      firstSeenAt: '2026-05-11T00:00:00.000Z',
      discoveredFrom: {
        sessionId: 'sess_20260511_0000_web_abcd',
        traceRefs: ['trace/run.log'],
      },
      learnedMethodSummary: 'Public API fetch.',
    },
    capabilities: [
      {
        id: 'fetch_rows',
        operation: 'query',
        inputSchema: {
          type: 'object',
        },
        outputSchema: {
          type: 'object',
        },
        watchable: true,
        defaultPrivacyScope: 'public',
        allowedActions: ['recordObservation'],
        prohibitedActions: ['write'],
      },
    ],
    adapter: {
      mode: 'api',
      activeRevision: 'api-v1',
      revisions: [
        {
          id: 'api-v1',
          status: 'active',
          mode: 'api',
          entrypoint: 'https://example.invalid',
          endpointTemplates: ['https://example.invalid/data'],
          parser: {
            type: 'json',
            schemaKeys: ['data'],
          },
          timeoutMs: 1000,
          validation: {
            sampleQueries: [{}],
            expectedEvidence: ['HTTP 200'],
          },
        },
      ],
    },
    credentials: [
      {
        id: 'none',
        required: false,
        binding: {
          type: 'none',
        },
        scopes: ['public.read'],
        injectAs: 'none',
        leasePolicy: {
          ttlSeconds: 0,
          renewable: false,
          reauthRequiredOn: [],
        },
      },
    ],
    privacy: {
      dataClasses: ['public rows'],
      bodyPolicy: 'approved_background_scope',
      attachmentPolicy: 'blocked',
      retention: {
        card: 'until retired',
        observations: '14 days',
        artifacts: 'explicit artifacts only',
      },
    },
    health: {
      checks: [
        {
          id: 'api-health',
          cadence: 'before_watch_tick',
          method: 'Fetch public health.',
          successCriteria: 'HTTP 200.',
        },
      ],
    },
    observations: {
      observationSchemaRef: 'source-observation/public-v1',
      cursorPolicy: 'watch-owned',
      maxSamplePersisted: 1,
      contentHashPolicy: 'hash rows',
    },
    promotion: {
      requiredEvidence: ['public read-only endpoint'],
    },
  }
}

describe('Source Card types', () => {
  test('defines the Source Card lifecycle transitions', () => {
    expect(canTransitionSourceCardState('discovered', 'candidate')).toBe(true)
    expect(canTransitionSourceCardState('candidate', 'verified')).toBe(true)
    expect(canTransitionSourceCardState('verified', 'active')).toBe(true)
    expect(canTransitionSourceCardState('active', 'degraded')).toBe(true)
    expect(canTransitionSourceCardState('degraded', 'active')).toBe(true)
    expect(canTransitionSourceCardState('active', 'discovered')).toBe(false)
  })

  test('validates a complete active card', () => {
    const result = validateSourceCard(createActiveCard())

    expect(result).toEqual({ ok: true, errors: [] })
  })

  test('rejects invalid credential binding refs', () => {
    const card = createActiveCard()
    card.credentials = [
      {
        ...card.credentials[0],
        binding: {
          type: 'vaultRef',
          ref: 'plain-secret-id',
        },
      },
    ]

    const result = validateSourceCard(card)

    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('must start with vault://')
  })

  test('allows watch bindings to reference only source card capability and cadence', () => {
    const card = createActiveCard()

    expect(() =>
      assertValidSourceWatchBinding(
        {
          sourceCardId: card.id,
          capabilityId: 'fetch_rows',
          query: {
            symbol: 'SH000001',
          },
          cadence: {
            type: 'interval',
            minIntervalMs: 60_000,
          },
        },
        card,
      ),
    ).not.toThrow()
  })

  test('rejects credentials embedded in watch bindings', () => {
    const card = createActiveCard()
    const result = validateSourceWatchBinding(
      {
        sourceCardId: card.id,
        capabilityId: 'fetch_rows',
        query: {
          credentialRef: 'vault://example',
        },
        cadence: {
          type: 'interval',
          minIntervalMs: 60_000,
        },
      },
      card,
    )

    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('must not contain credentials')
  })

  test('redacts trace evidence but preserves credential references', () => {
    const evidence = sanitizeSourceCardTraceEvidence({
      credentialRef: 'external:himalaya/account/qq',
      authorization: 'Bearer secret-token',
      headers: {
        cookie: 'sid=secret',
      },
      message: 'token=secret-value',
    })

    expect(evidence).toEqual({
      credentialRef: 'external:himalaya/account/qq',
      authorization: '[REDACTED]',
      headers: {
        cookie: '[REDACTED]',
      },
      message: 'token=[REDACTED]',
    })
  })
})
