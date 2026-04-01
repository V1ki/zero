import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CostOverview } from '../CostOverview'

describe('CostOverview', () => {
  test('renders the dashboard cost summary shell', () => {
    const html = renderToStaticMarkup(<CostOverview />)

    expect(html).toContain('Cost Overview')
    expect(html).toContain('Today')
    expect(html).toContain('This Week')
    expect(html).toContain('This Month')
  })
})
