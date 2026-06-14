import { Warning } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { useWebSocket } from '../../useWebSocket'
import { apiFetch, apiPost } from '../../lib/api'
import { formatTimeAgo } from '../../lib/format'
import { useUIStore } from '../../stores/ui'

interface Notification {
  id: string
  type?: string
  severity?: string
  title?: string
  ts?: string
  level?: string
  source: string
  description: string
  sessionId?: string
  actionable?: boolean
  actionUrl?: string
  createdAt?: string
  dismissedAt?: string
}

const MAX_VISIBLE = 5

const URGENT_TYPES = new Set(['authorization', 'verification'])

const severityDot: Record<string, string> = {
  warn: 'bg-amber-400',
  error: 'bg-red-400',
  info: 'bg-cyan-400',
}

async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false

  const result = await Notification.requestPermission()
  return result === 'granted'
}

function sendBrowserNotification(title: string, body: string): void {
  if (!('Notification' in window)) return
  if (Notification.permission !== 'granted') return

  new Notification(title, {
    body,
    icon: '/assets/icon.png',
    tag: 'zero-os-notification',
  })
}

export function AttentionCard() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const { setCurrentPage } = useUIStore()

  // Request browser notification permission on mount
  useEffect(() => {
    requestNotificationPermission()
  }, [])

  // Initial HTTP fetch
  useEffect(() => {
    apiFetch<{ notifications: Notification[] }>('/api/notifications')
      .then((res) => setNotifications(res.notifications))
      .catch(() => {})
  }, [])

  // WebSocket real-time updates
  const onEvent = useCallback((topic: string, data: unknown) => {
    if (topic === 'notification') {
      const payload = data as Record<string, unknown>
      const n = payload.notification as Notification | undefined
      if (n) {
        setNotifications((prev) => [n, ...prev])

        // Browser notification for urgent types
        if (n.type && URGENT_TYPES.has(n.type)) {
          sendBrowserNotification(n.title ?? 'ZeRo OS Alert', n.description)
        }
      }
    }
  }, [])

  useWebSocket({
    url: `ws://${window.location.host}/ws`,
    topics: ['notification'],
    onEvent,
  })

  if (notifications.length === 0) return null

  const visible = notifications.slice(0, MAX_VISIBLE)
  const hasMore = notifications.length > MAX_VISIBLE

  function handleDismiss(id: string) {
    apiPost(`/api/notifications/${id}/dismiss`, {}).catch(() => {})
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }

  function handleAction(n: Notification) {
    if (n.actionUrl) {
      setCurrentPage(n.actionUrl)
    } else if (n.sessionId) {
      setCurrentPage('session-detail')
    }
  }

  return (
    <div
      className="card p-5 animate-fade-up border border-amber-400/30"
      style={{ boxShadow: '0 0 20px rgba(251, 191, 36, 0.1)' }}
    >
      <div className="flex items-center gap-2 mb-4">
        <Warning size={18} weight="fill" className="text-amber-400" />
        <h3 className="text-[14px] font-semibold text-amber-400">Needs Attention</h3>
      </div>

      <div className="space-y-2">
        {visible.map((n, i) => {
          const level = n.severity ?? n.level ?? 'warn'
          const timestamp = n.createdAt ?? n.ts ?? ''
          return (
            <div key={n.id ?? i} className="flex items-center justify-between gap-3 py-1.5">
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${severityDot[level] ?? 'bg-amber-400'}`}
                />
                <span className="text-[13px] text-[var(--color-text-secondary)] truncate">
                  {n.title ?? n.description}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-white/[0.04] text-[var(--color-text-muted)]">
                  {n.source}
                </span>
                {timestamp && (
                  <span className="text-[11px] text-[var(--color-text-disabled)] w-12 text-right">
                    {formatTimeAgo(timestamp)}
                  </span>
                )}
                {n.actionable && (
                  <button
                    type="button"
                    onClick={() => handleAction(n)}
                    className="text-[11px] px-2 py-0.5 rounded bg-cyan-400 text-[var(--color-deep-bg)] font-medium hover:bg-cyan-300 transition-colors"
                  >
                    处理
                  </button>
                )}
                {n.sessionId && !n.actionable && (
                  <button
                    type="button"
                    className="text-[11px] text-[var(--color-accent)] cursor-pointer hover:underline"
                    onClick={() => handleAction(n)}
                  >
                    详情
                  </button>
                )}
                {n.id && (
                  <button
                    type="button"
                    onClick={() => handleDismiss(n.id)}
                    className="text-[11px] text-[var(--color-text-disabled)] hover:text-[var(--color-text-muted)] transition-colors"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {hasMore && (
        <button
          type="button"
          className="text-[12px] text-[var(--color-accent)] mt-3 cursor-pointer hover:underline"
          onClick={() => setCurrentPage('logs')}
        >
          View all in Logs ({notifications.length} total)
        </button>
      )}
    </div>
  )
}
