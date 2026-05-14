import { describe, expect, test } from 'bun:test'
import type { SourceCard } from '@zero-os/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ActivateSourceDialog,
  RetireSourceDialog,
  SourceCardDetailView,
  SourceCardTableView,
  getSourceCardReadiness,
} from './source-cards'

function createCard(overrides: Partial<SourceCard> = {}): SourceCard {
  return {
    schemaVersion: 1,
    id: 'qq-mail-source',
    title: 'QQ Mail source',
    state: 'draft',
    sensitivity: 'private',
    tags: ['mail', 'qq-mail', 'himalaya'],
    sourceDoc: {
      format: 'markdown',
      body: '# QQ Mail source\n\n## When to use\n- Use for QQ Mail metadata.\n\n## How to use\n- Use himalaya CLI metadata commands first.\n\n## Safety boundary\n- Do not read body content or attachments without explicit approval.',
    },
    source: {
      sessionId: 'sess_20260512_1030_web_mine',
      traceRefs: ['trace:span_mail'],
      summary: 'Mined from existing QQ Mail metadata evidence.',
    },
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:10:00.000Z',
    ...overrides,
  }
}

describe('Source Cards UI', () => {
  test('computes document-card readiness from the simplified lifecycle', () => {
    expect(getSourceCardReadiness(createCard())).toMatchObject({
      label: 'Draft review',
      tone: 'draft',
    })
    expect(getSourceCardReadiness(createCard({ state: 'active' }))).toMatchObject({
      label: 'Active',
      tone: 'active',
    })
    expect(getSourceCardReadiness(createCard({ state: 'retired' }))).toMatchObject({
      label: 'Retired',
      tone: 'retired',
    })
  })

  test('renders a compact table without adapter, health, or credential columns', () => {
    const html = renderToStaticMarkup(
      <SourceCardTableView
        sourceCards={[createCard(), createCard({ id: 'a-share-source', title: 'A-share data' })]}
        onOpen={() => {}}
      />,
    )

    expect(html).toContain('QQ Mail source')
    expect(html).toContain('qq-mail-source')
    expect(html).toContain('draft')
    expect(html).toContain('private')
    expect(html).toContain('A-share data')
    expect(html).not.toContain('adapter')
    expect(html).not.toContain('credential')
    expect(html).not.toContain('health')
    expect(html).not.toContain('external:himalaya/account/qq')
  })

  test('renders Source Card detail as a Markdown document with source evidence', () => {
    const html = renderToStaticMarkup(<SourceCardDetailView card={createCard()} />)

    expect(html).toContain('QQ Mail source')
    expect(html).toContain('Source Doc')
    expect(html).toContain('himalaya CLI metadata commands first')
    expect(html).toContain('Source Evidence')
    expect(html).toContain('sess_20260512_1030_web_mine')
    expect(html).toContain('trace:span_mail')
    expect(html).not.toContain('external:himalaya/account/qq')
    expect(html).not.toContain('credentialRef')
  })

  test('activate dialog requires a reason before submission', () => {
    const html = renderToStaticMarkup(
      <ActivateSourceDialog
        card={createCard()}
        open={true}
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    )

    expect(html).toContain('Activate Source Card')
    expect(html).toContain('Activation reason')
    expect(html).toContain('disabled=""')
  })

  test('retire dialog requires a reason before submission', () => {
    const html = renderToStaticMarkup(
      <RetireSourceDialog
        card={createCard({ state: 'active' })}
        open={true}
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    )

    expect(html).toContain('Retire Source Card')
    expect(html).toContain('Retire reason')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('external:himalaya/account/qq')
  })
})
