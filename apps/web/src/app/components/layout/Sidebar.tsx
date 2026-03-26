import {
  Brain,
  CaretDown,
  ChartBar,
  ChatCircle,
  ClipboardText,
  ClockCounterClockwise,
  Gauge,
  Gear,
  List,
  Terminal,
  Wrench,
} from '@phosphor-icons/react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, apiPost } from '../../lib/api'
import { useUIStore } from '../../stores/ui'

const navItems = [
  { name: 'Dashboard', icon: Gauge, path: '/' },
  { name: 'Sessions', icon: ClockCounterClockwise, path: '/sessions' },
  { name: 'Memory', icon: Brain, path: '/memory' },
  { name: 'Memo', icon: ClipboardText, path: '/memo' },
  { name: 'Tools', icon: Wrench, path: '/tools' },
  { name: 'Logs', icon: Terminal, path: '/logs' },
  { name: 'Config', icon: Gear, path: '/config' },
  { name: 'Metrics', icon: ChartBar, path: '/metrics' },
]

interface SidebarProps {
  collapsed?: boolean
}

export function Sidebar({ collapsed = false }: SidebarProps) {
  const { toggleChatDrawer, toggleSidebar, sidebarCollapsed, addToast } = useUIStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [showModelPicker, setShowModelPicker] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  const isCollapsed = collapsed || sidebarCollapsed
  const width = isCollapsed ? 44 : 220

  useEffect(() => {
    apiFetch<{ models: { name: string }[] }>('/api/models')
      .then((res) => setModels(res.models.map((m) => m.name)))
      .catch(() => {})
    apiFetch<{ currentModel: string }>('/api/status')
      .then((res) => {
        if (res.currentModel) setCurrentModel(res.currentModel)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false)
      }
    }
    if (showModelPicker) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showModelPicker])

  async function switchModel(name: string) {
    try {
      const result = await apiPost<{ currentModel: string }>('/api/chat/model', { model: name })
      setCurrentModel(result.currentModel)
      setShowModelPicker(false)
      addToast('success', `模型已切换至 ${result.currentModel}`)
    } catch {
      // Error toast handled by api layer
    }
  }

  return (
    <aside
      className="fixed left-0 top-0 h-full flex flex-col bg-[var(--color-main-bg)] border-r border-[var(--color-border)] z-40 transition-[width] duration-200"
      style={{ width }}
    >
      {/* Logo / hamburger */}
      <div className={`flex items-center ${isCollapsed ? 'justify-center py-3' : 'px-5 py-5'}`}>
        {isCollapsed ? (
          <button
            type="button"
            onClick={toggleSidebar}
            className="p-1 rounded-md hover:bg-white/[0.05] text-[var(--color-text-muted)]"
          >
            <List size={20} />
          </button>
        ) : (
          <span className="text-[14px] font-bold tracking-tight text-[var(--color-text-primary)]">
            ZeRo
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className={`flex-1 ${isCollapsed ? 'px-1' : 'px-3'} space-y-0.5`}>
        {navItems.map((item) => {
          const isActive =
            location.pathname === item.path ||
            (item.path !== '/' && location.pathname.startsWith(`${item.path}/`))
          return (
            <button
              key={item.path}
              type="button"
              onClick={() => navigate({ to: item.path })}
              title={isCollapsed ? item.name : undefined}
              className={`w-full flex items-center ${isCollapsed ? 'justify-center px-0 py-2' : 'gap-3 px-3 py-2'} rounded-lg text-[13px] transition-colors ${
                isActive
                  ? 'text-[var(--color-text-primary)] bg-[var(--color-accent-glow)] border-l-2 border-[var(--color-accent)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-white/[0.03]'
              }`}
            >
              <item.icon size={18} weight={isActive ? 'fill' : 'regular'} />
              {!isCollapsed && item.name}
            </button>
          )
        })}
      </nav>

      {/* Bottom section: status + chat button */}
      <div
        className={`${isCollapsed ? 'px-1' : 'px-4'} py-4 space-y-3 border-t border-[var(--color-border)]`}
      >
        {!isCollapsed && (
          <div className="space-y-1 relative" ref={pickerRef}>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[var(--color-success)] pulse-active" />
              <span className="text-[11px] text-[var(--color-text-secondary)]">Running</span>
            </div>
            <button
              type="button"
              onClick={() => setShowModelPicker((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-mono text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors w-full text-left"
            >
              <span className="truncate flex-1">{currentModel ?? 'Loading model...'}</span>
              <CaretDown
                size={10}
                className={`shrink-0 transition-transform ${showModelPicker ? 'rotate-180' : ''}`}
              />
            </button>
            <p className="text-[11px] font-mono text-[var(--color-text-disabled)]">v0.1 stable</p>

            {showModelPicker && models.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-float)] shadow-lg overflow-hidden z-50 animate-fade-up max-h-[200px] overflow-y-auto">
                {models.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => switchModel(m)}
                    className={`w-full text-left px-3 py-1.5 text-[11px] font-mono transition-colors ${
                      m === currentModel
                        ? 'text-[var(--color-accent)] bg-[var(--color-accent-glow)]'
                        : 'text-[var(--color-text-secondary)] hover:bg-white/[0.04]'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={toggleChatDrawer}
          title={isCollapsed ? 'Chat' : undefined}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:border-[var(--color-border-hover)] transition-colors"
        >
          <ChatCircle size={18} />
          {!isCollapsed && <span className="text-[12px]">Chat</span>}
        </button>
      </div>
    </aside>
  )
}
