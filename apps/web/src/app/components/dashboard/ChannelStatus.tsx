import { Plugs } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { useWebSocket } from '../../useWebSocket'
import { apiFetch } from '../../lib/api'

interface Channel {
  name: string
  type?: string
  status: string
}

export function ChannelStatus() {
  const [channels, setChannels] = useState<Channel[]>([])

  // Initial HTTP fetch
  useEffect(() => {
    apiFetch<{ channels: Channel[] }>('/api/channels/status')
      .then((res) => setChannels(res.channels))
      .catch(() => {})
  }, [])

  // WebSocket real-time channel status updates
  const onEvent = useCallback((topic: string, _data: unknown) => {
    if (topic === 'heartbeat') {
      // Re-fetch channel status on heartbeat
      apiFetch<{ channels: Channel[] }>('/api/channels/status')
        .then((res) => setChannels(res.channels))
        .catch(() => {})
    }
  }, [])

  useWebSocket({
    url: `ws://${window.location.host}/ws`,
    topics: ['heartbeat'],
    onEvent,
  })

  if (channels.length === 0) return null

  const hasOffline = channels.some((ch) => ch.status !== 'online')

  // Auto-hide when all channels are online
  if (!hasOffline) return null

  return (
    <div
      className={`card px-4 py-2.5 animate-fade-up flex items-center gap-3 ${
        hasOffline ? 'border border-red-400/30' : ''
      }`}
      style={hasOffline ? { boxShadow: '0 0 12px rgba(248, 113, 113, 0.1)' } : undefined}
    >
      <Plugs size={16} weight="bold" className={hasOffline ? 'text-red-400' : 'text-slate-500'} />
      <div className="flex items-center gap-4 flex-wrap">
        {channels.map((ch) => {
          const isOnline = ch.status === 'online'
          return (
            <div key={ch.name} className="flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-red-400 animate-pulse'}`}
              />
              <span
                className={`text-[12px] font-mono ${isOnline ? 'text-slate-500' : 'text-red-400'}`}
              >
                {ch.name}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
