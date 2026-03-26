import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { useUIStore } from '../../../stores/ui'

mock.module('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/' }),
  useNavigate: () => () => {},
}))

const { Sidebar } = await import('../Sidebar')

describe('Sidebar', () => {
  beforeEach(() => {
    useUIStore.setState({
      chatDrawerOpen: false,
      currentPage: 'dashboard',
      sidebarCollapsed: false,
      selectedSessionId: null,
      isMobile: false,
      isTablet: false,
      toasts: [],
    })
  })

  test('does not render a stale hardcoded model before status loads', () => {
    const html = renderToStaticMarkup(<Sidebar />)

    expect(html).toContain('Loading model...')
    expect(html).toContain('Dashboard')
    expect(html).not.toContain('openai-codex/gpt-5.3-codex-medium')
  })
})
