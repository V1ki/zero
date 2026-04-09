import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { RootLayout } from './RootLayout'
import { ConfigPage } from './routes/config'
import { DashboardPage } from './routes/dashboard'
import { LogsPage } from './routes/logs'
import { MemoPage } from './routes/memo'
import { MemoryPage } from './routes/memory'
import { MetricsPage } from './routes/metrics'
import { SessionChannelDetailPage } from './routes/session-channel-detail'
import { SessionDetailPage } from './routes/session-detail'
import { SessionsPage } from './routes/sessions'
import { ToolsPage } from './routes/tools'

const rootRoute = createRootRoute({
  component: RootLayout,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
})

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsPage,
})

const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$id',
  component: SessionDetailPage,
})

const sessionChannelDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/channel/$channel/detail',
  validateSearch: (search: Record<string, unknown>) => ({
    source: typeof search.source === 'string' ? search.source : undefined,
    channelName: typeof search.channelName === 'string' ? search.channelName : undefined,
  }),
  component: SessionChannelDetailPage,
})

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/memory',
  component: MemoryPage,
})

const memoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/memo',
  component: MemoPage,
})

const toolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tools',
  component: ToolsPage,
})

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logs',
  component: LogsPage,
})

const configRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/config',
  component: ConfigPage,
})

const metricsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/metrics',
  component: MetricsPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  sessionsRoute,
  sessionDetailRoute,
  sessionChannelDetailRoute,
  memoryRoute,
  memoRoute,
  toolsRoute,
  logsRoute,
  configRoute,
  metricsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
