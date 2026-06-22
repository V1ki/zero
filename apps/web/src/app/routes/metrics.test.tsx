import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MetricsPage } from './metrics'

describe('MetricsPage', () => {
  test('renders the expanded analytics tabs', () => {
    const html = renderToStaticMarkup(<MetricsPage />)

    expect(html).toContain('Cost')
    expect(html).toContain('Purpose')
    expect(html).toContain('Attribution')
    expect(html).toContain('Evaluations')
    expect(html).toContain('Health')
  })

  test('renders cost page daily model spend sections', () => {
    const html = renderToStaticMarkup(<MetricsPage />)

    expect(html).toContain('Total Cost')
    expect(html).toContain('Total Tokens')
    expect(html).toContain('Cumulative Token Usage')
    expect(html).toContain('Daily Model Spend')
    expect(html).toContain('Cache Efficiency')
  })

  test('renders custom date range controls', () => {
    const html = renderToStaticMarkup(<MetricsPage />)

    expect(html).toContain('Custom')
  })
})
