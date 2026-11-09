import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { RootLayout } from './RootLayout'
import { ConfigPage } from './routes/config'
import { DashboardPage } from './routes/dashboard'
import { LogsPage } from './routes/logs'
import { MemoPage } from './routes/memo'
import { MemoryPage } from './routes/memory'
import { MetricsPage } from './routes/metrics'
import { RouterTracesPage } from './routes/router-traces'
import { RouterWorkspacePage } from './routes/router-workspace'
import {
  SessionChannelDetailRedirectPage,
  SessionSourceDetailPage,
} from './routes/session-channel-detail'
import { SessionDetailPage } from './routes/session-detail'
import { SessionRunLogPage } from './routes/session-run-log'
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

const runtimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runtime',
  component: DashboardPage,
})

const routerWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/router',
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    event?: number
    task?: number
    matterId?: string
    view?: 'tasks' | 'chat' | 'notifications'
  } => {
    const positiveId = (raw: unknown) => {
      const id = typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : raw
      return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined
    }
    const task = positiveId(search.task)
    return {
      event: positiveId(search.event),
      task,
      matterId: typeof search.matterId === 'string' ? search.matterId : undefined,
      view:
        search.view === 'tasks' || search.view === 'notifications'
          ? search.view
          : search.view === 'chat' && task
            ? 'chat'
            : undefined,
    }
  },
  component: RouterWorkspacePage,
})

const routerTracesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/router/traces',
  component: RouterTracesPage,
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
  component: SessionChannelDetailRedirectPage,
})

const sessionSourceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/source/$source/detail',
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search.id === 'string' ? search.id : undefined,
    channelName: typeof search.channelName === 'string' ? search.channelName : undefined,
  }),
  component: SessionSourceDetailPage,
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

const sessionRunLogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logs/session/$id',
  component: SessionRunLogPage,
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
  runtimeRoute,
  routerWorkspaceRoute,
  routerTracesRoute,
  sessionsRoute,
  sessionDetailRoute,
  sessionSourceDetailRoute,
  sessionChannelDetailRoute,
  memoryRoute,
  memoRoute,
  toolsRoute,
  logsRoute,
  sessionRunLogRoute,
  configRoute,
  metricsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
