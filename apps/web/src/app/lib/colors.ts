/**
 * Unified type → color mapping for the entire UI.
 */
export const typeColors: Record<string, string> = {
  session: 'text-cyan-400',
  incident: 'text-red-400',
  runbook: 'text-emerald-400',
  decision: 'text-amber-400',
  note: 'text-blue-400',
  preference: 'text-violet-400',
  inbox: 'text-pink-400',
}

export const typeBgColors: Record<string, string> = {
  session: 'bg-cyan-400/10',
  incident: 'bg-red-400/10',
  runbook: 'bg-emerald-400/10',
  decision: 'bg-amber-400/10',
  note: 'bg-blue-400/10',
  preference: 'bg-violet-400/10',
  inbox: 'bg-pink-400/10',
}

export const statusColors: Record<string, string> = {
  running: 'text-emerald-400',
  degraded: 'text-amber-400',
  repairing: 'text-amber-400',
  fused: 'text-red-400',
  active: 'text-emerald-400',
  idle: 'text-slate-500',
  completed: 'text-slate-400',
  failed: 'text-red-400',
}

export const statusDotColors: Record<string, string> = {
  running: 'bg-emerald-400',
  degraded: 'bg-amber-400',
  repairing: 'bg-amber-400',
  fused: 'bg-red-400',
  active: 'bg-emerald-400',
  idle: 'bg-slate-500',
}

export const toolColors: Record<string, string> = {
  bash: 'text-cyan-400',
  read: 'text-slate-400',
  read_image: 'text-slate-400',
  edit: 'text-slate-400',
  write: 'text-emerald-400',
  browser: 'text-amber-400',
}

export const toolBgColors: Record<string, string> = {
  bash: 'bg-cyan-400',
  read: 'bg-slate-400',
  read_image: 'bg-slate-400',
  edit: 'bg-slate-400',
  write: 'bg-emerald-400',
  browser: 'bg-amber-400',
}
