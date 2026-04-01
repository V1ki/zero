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
})
