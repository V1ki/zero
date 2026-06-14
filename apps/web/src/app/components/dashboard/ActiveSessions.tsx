import { useCallback, useEffect, useState } from 'react'
import { useWebSocket } from '../../useWebSocket'
import { apiFetch } from '../../lib/api'
import { formatTimeAgo } from '../../lib/format'
import { PulseDot } from '../shared/PulseDot'

interface Session {
  id: string
  source: string
  channelName?: string
  isCurrent: boolean
  placement: 'current' | 'background'
  currentModel: string
  createdAt: string
  summary: string
  toolCallCount: number
  userMessageCount: number
  assistantMessageCount: number
}

interface ToolEvent {
  sessionId?: string
  tool?: string
  event?: string
}

export function ActiveSessions() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [liveTools, setLiveTools] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    function poll() {
      apiFetch<{ sessions: Session[] }>('/api/sessions?filter=current')
        .then((res) => setSessions(res.sessions))
        .catch(() => {})
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [])

  // WebSocket: live tool call streaming
  const onEvent = useCallback((topic: string, data: unknown) => {
    const ev = data as ToolEvent
    const sessionId = ev?.sessionId
    if (!sessionId) return

    if (topic.startsWith('tool:call')) {
      setLiveTools((prev) => {
        const next = new Map(prev)
        next.set(sessionId, ev.tool ?? 'unknown')
        return next
      })
    } else if (topic.startsWith('tool:result')) {
      setLiveTools((prev) => {
        const next = new Map(prev)
        next.delete(sessionId)
        return next
      })
    }
  }, [])

  useWebSocket({
    url: `ws://${window.location.host}/ws`,
    topics: ['tool:call', 'tool:result'],
    onEvent,
  })

  return (
    <div className="card p-5 animate-fade-up" style={{ animationDelay: '160ms' }}>
      <h3 className="text-[14px] font-semibold mb-4 text-[var(--color-text-secondary)]">
        Current Sessions
      </h3>

      {sessions.length === 0 ? (
        <p className="text-[13px] text-[var(--color-text-muted)] py-8 text-center">
          No current sessions
        </p>
      ) : (
        <div className="space-y-3">
          {sessions.map((s) => {
            const activeTool = liveTools.get(s.id)
            const channelName = s.channelName?.trim()
            const showChannelName = channelName && channelName !== s.source
            return (
              <div key={s.id} className="rounded-lg bg-white/[0.02] p-3">
                <div className="flex items-center gap-2.5 mb-1 min-w-0">
                  <PulseDot status={s.isCurrent ? 'active' : 'idle'} size={8} />
                  <span className="text-[12px] font-mono text-[var(--color-text-primary)] shrink-0">
                    {s.id.slice(0, 8)}
                  </span>
                  <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-white/[0.04] text-[var(--color-text-muted)] shrink-0">
                    {s.source}
                  </span>
                  {showChannelName && (
                    <span
                      className="text-[11px] font-mono px-1.5 py-0.5 rounded max-w-[140px] truncate bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                      title={channelName}
                    >
                      {channelName}
                    </span>
                  )}
                  <span className="text-[11px] font-mono text-[var(--color-text-muted)] min-w-0 truncate">
                    {s.currentModel}
                  </span>
                  <span className="text-[11px] text-[var(--color-text-disabled)] ml-auto shrink-0">
                    {formatTimeAgo(s.createdAt)}
                  </span>
                </div>
                {s.summary && (
                  <p className="text-[12px] text-[var(--color-text-muted)] ml-5 truncate">
                    {s.summary}
                  </p>
                )}
                <div className="ml-5 mt-0.5 flex items-center gap-2">
                  <span className="text-[11px] text-[var(--color-text-disabled)]">
                    {s.userMessageCount} user · {s.assistantMessageCount} assistant ·{' '}
                    {s.toolCallCount} tool call{s.toolCallCount !== 1 ? 's' : ''}
                  </span>
                  {activeTool && (
                    <span className="text-[11px] text-[var(--color-accent)] animate-pulse">
                      running: {activeTool}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
