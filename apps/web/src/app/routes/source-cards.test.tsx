import { describe, expect, test } from 'bun:test'
import {
  createAStockMarketDataSourceCard,
  createQqMailHimalayaSourceCard,
  toPublicSourceCard,
} from '@zero-os/core'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PromoteSourceDrawer,
  RetireSourceDialog,
  SourceCardDetailView,
  SourceCardTableView,
  type SourceObservationSummaryResponse,
  getWatchEligibility,
} from './source-cards'

const qqMail = toPublicSourceCard(createQqMailHimalayaSourceCard())
const stock = toPublicSourceCard(createAStockMarketDataSourceCard())

function emptySummary(sourceCardId: string): SourceObservationSummaryResponse {
  return {
    sourceCardId,
    summaryOnly: true,
    summary: {
      total: 0,
      kindCounts: {},
      capabilityIds: [],
    },
    observations: [],
  }
}

describe('Source Cards UI', () => {
  test('computes watch eligibility without giving candidate private mail watch access', () => {
    expect(getWatchEligibility(qqMail)).toMatchObject({
      label: 'Needs verification',
      tone: 'pending',
    })
    expect(getWatchEligibility(stock)).toMatchObject({
      label: 'Allowed',
      tone: 'allowed',
    })
  })

  test('renders a dense read-only table for private and public sample cards', () => {
    const html = renderToStaticMarkup(
      <SourceCardTableView sourceCards={[qqMail, stock]} onOpen={() => {}} />,
    )

    expect(html).toContain('QQ Mail via himalaya CLI')
    expect(html).toContain('qq-mail-himalaya')
    expect(html).toContain('candidate')
    expect(html).toContain('private')
    expect(html).toContain('Needs verification')
    expect(html).toContain('A-share market data')
    expect(html).toContain('a-stock-market-data')
    expect(html).toContain('active')
    expect(html).toContain('public')
    expect(html).toContain('Allowed')
    expect(html).not.toContain('external:himalaya/account/qq')
  })

  test('renders private Source Card detail without body, attachment, or credential refs', () => {
    const html = renderToStaticMarkup(
      <SourceCardDetailView card={qqMail} observationSummary={emptySummary(qqMail.id)} />,
    )

    expect(html).toContain('QQ Mail via himalaya CLI')
    expect(html).toContain('private mailbox')
    expect(html).toContain('Metadata only by default')
    expect(html).toContain('Mail body content is hidden')
    expect(html).toContain('Attachments are blocked')
    expect(html).toContain('externalStore')
    expect(html).toContain('configured reference present')
    expect(html).not.toContain('external:himalaya/account/qq')
    expect(html).not.toContain('binding.ref')
  })

  test('renders public market Source Card detail as read-only and no-trading', () => {
    const html = renderToStaticMarkup(
      <SourceCardDetailView card={stock} observationSummary={emptySummary(stock.id)} />,
    )

    expect(html).toContain('A-share market data')
    expect(html).toContain('public market data')
    expect(html).toContain('Public read-only market data')
    expect(html).toContain('No broker login')
    expect(html).toContain('No order placement')
    expect(html).toContain('place_order')
    expect(html).toContain('use_broker_account')
    expect(html).not.toContain('external:himalaya/account/qq')
  })

  test('renders promote drawer private metadata-only confirmation without credential refs', () => {
    const verifiedQq = { ...qqMail, state: 'verified' as const }
    const html = renderToStaticMarkup(
      <PromoteSourceDrawer card={verifiedQq} open={true} onClose={() => {}} onSubmit={() => {}} />,
    )

    expect(html).toContain('Promote Source Card')
    expect(html).toContain('private metadata-only scope confirmed')
    expect(html).toContain('Confirm private metadata-only scope')
    expect(html).toContain('Background body access and attachment access remain rejected')
    expect(html).not.toContain('external:himalaya/account/qq')
    expect(html).not.toContain('credentialRef')
    expect(html).not.toContain('binding.ref')
  })

  test('retire dialog requires a reason before submission', () => {
    const html = renderToStaticMarkup(
      <RetireSourceDialog card={stock} open={true} onClose={() => {}} onSubmit={() => {}} />,
    )

    expect(html).toContain('Retire Source Card')
    expect(html).toContain('Retire reason')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('external:himalaya/account/qq')
  })
})
