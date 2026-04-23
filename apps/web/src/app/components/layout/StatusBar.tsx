import { Heartbeat } from '@phosphor-icons/react'

interface StatusBarProps {
  status: 'running' | 'degraded' | 'repairing' | 'fused'
  model: string
  uptime: string
  heartbeatAge: number
  currentSessions: number
}

export function StatusBar({ status, model, uptime, heartbeatAge, currentSessions }: StatusBarProps) {
  const statusConfig = {
    running: { label: 'Running', dot: 'bg-emerald-400', text: 'text-emerald-400', bg: '' },
    degraded: {
      label: 'Degraded',
      dot: 'bg-amber-400',
      text: 'text-amber-400',
      bg: 'bg-amber-400/5',
    },
    repairing: {
      label: 'Repairing',
      dot: 'bg-amber-400 pulse-active',
      text: 'text-amber-400',
      bg: 'bg-amber-400/5',
    },
    fused: {
      label: 'Fused',
      dot: 'bg-red-400 pulse-active',
      text: 'text-red-400',
      bg: 'bg-red-400/5',
    },
  }

  const cfg = statusConfig[status]
  const heartbeatColor =
    heartbeatAge > 50
      ? 'text-red-400'
      : heartbeatAge > 30
        ? 'text-amber-400'
        : 'text-[var(--color-text-disabled)]'

  return (
    <div
      className={`flex items-center gap-6 px-5 py-2 text-[11px] tracking-wide border-b border-[var(--color-border)] ${cfg.bg}`}
    >
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
        <span className={cfg.text}>{cfg.label}</span>
      </div>

      <span className="text-[var(--color-text-muted)] font-mono">{model}</span>

      <span className="text-[var(--color-text-disabled)]">Uptime {uptime}</span>

      <div className={`flex items-center gap-1 ${heartbeatColor}`}>
        <Heartbeat size={12} />
        <span className="font-mono">{heartbeatAge}s ago</span>
      </div>

      <span className="text-[var(--color-text-disabled)]">
        {currentSessions} session{currentSessions !== 1 ? 's' : ''} current
      </span>
    </div>
  )
}
