import {
  ArrowsSplit,
  Brain,
  ClockCounterClockwise,
  Gauge,
  Gear,
  Wrench,
} from '@phosphor-icons/react'
import { useLocation, useNavigate } from '@tanstack/react-router'

const tabItems = [
  { name: 'Dashboard', icon: Gauge, path: '/' },
  { name: 'Router', icon: ArrowsSplit, path: '/router' },
  { name: 'Sessions', icon: ClockCounterClockwise, path: '/sessions' },
  { name: 'Memory', icon: Brain, path: '/memory' },
  { name: 'Tools', icon: Wrench, path: '/tools' },
  { name: 'Config', icon: Gear, path: '/config' },
]

export function TabBar() {
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 bg-[var(--color-main-bg)] border-t border-[var(--color-border)] flex items-center justify-around"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {tabItems.map((item) => {
        const isActive =
          location.pathname === item.path ||
          (item.path !== '/' && location.pathname.startsWith(`${item.path}/`))
        return (
          <button
            key={item.path}
            type="button"
            onClick={() => navigate({ to: item.path })}
            className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 transition-colors ${
              isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'
            }`}
          >
            <item.icon size={20} weight={isActive ? 'fill' : 'regular'} />
            <span className="text-[10px]">{item.name}</span>
          </button>
        )
      })}
    </nav>
  )
}
