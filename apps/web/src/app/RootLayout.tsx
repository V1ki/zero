import { Outlet } from '@tanstack/react-router'
import { TriggerNotifications } from './components/TriggerNotifications'
import { ChatDrawer } from './components/layout/ChatDrawer'
import { Sidebar } from './components/layout/Sidebar'
import { TabBar } from './components/layout/TabBar'
import { ErrorBoundary } from './components/shared/ErrorBoundary'
import { ToastContainer } from './components/shared/Toast'
import { useUIStore } from './stores/ui'

export function RootLayout() {
  const { chatDrawerOpen, isMobile, isTablet } = useUIStore()
  const sidebarWidth = isMobile ? 0 : isTablet ? 44 : 220
  const drawerWidth = chatDrawerOpen ? (isMobile ? 0 : 360) : 0

  return (
    <>
      {/* Sidebar: hidden on mobile, collapsed on tablet, full on desktop */}
      {!isMobile && <Sidebar collapsed={isTablet} />}

      {/* Main content area */}
      <main
        className="transition-[margin-right] duration-300 ease-out"
        style={{
          marginLeft: sidebarWidth,
          marginRight: drawerWidth,
          paddingBottom: isMobile ? 56 : 0,
        }}
      >
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>

      {/* Chat drawer */}
      <ChatDrawer />

      {/* Mobile bottom tab bar */}
      {isMobile && <TabBar />}

      {/* Toast notifications */}
      <ToastContainer />
      <TriggerNotifications />
    </>
  )
}
