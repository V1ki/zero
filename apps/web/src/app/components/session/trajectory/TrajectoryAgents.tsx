/**
 * Sub-agent delegation strip: one chip per spawned agent with its lifecycle
 * status, model, child-tool count, and duration. Selecting a chip opens the
 * agent's ledger record so its Payload (instruction) and Result (child
 * tool-call trail plus output) render in the detail pane.
 */

import css from './TrajectoryAgents.module.css'

/** One sub-agent entry projected for the strip. */
export interface TrajectoryAgentEntry {
  readonly agentId: string
  readonly label: string
  readonly model?: string
  readonly status: string
  readonly durationMs?: number
  readonly toolCount: number
}

export interface TrajectoryAgentsProps {
  /** Sub-agent delegation records, in spawn order. */
  agents: readonly TrajectoryAgentEntry[]
  /** Agent id whose ledger record is currently selected, when known. */
  selectedAgentId: string | null
  /** Open the ledger record of one sub-agent. */
  onSelect: (agentId: string) => void
  /** Accessible label for the strip. */
  ariaLabel: string
}

/**
 * Render the sub-agent delegation strip.
 * @param props - entries plus selection handler.
 * @returns The strip element.
 */
export function TrajectoryAgents({
  agents,
  selectedAgentId,
  onSelect,
  ariaLabel,
}: TrajectoryAgentsProps) {
  return (
    <ul className={css.root} aria-label={ariaLabel}>
      {agents.map((agent) => (
        <li key={agent.agentId}>
          <button
            type="button"
            className={css.chip}
            data-status={agent.status}
            data-selected={agent.agentId === selectedAgentId || undefined}
            title={`${agent.label} · ${agent.status}`}
            onClick={() => {
              onSelect(agent.agentId)
            }}
          >
            <span className={css.dot} aria-hidden="true" />
            <span className={css.label}>{agent.label}</span>
            {agent.model === undefined || agent.model === '' ? null : (
              <span className={css.model}>{agent.model}</span>
            )}
            <span className={css.meta}>
              {agent.toolCount > 0 ? `${agent.toolCount} tools` : 'no tools'}
              {agent.durationMs === undefined ? '' : ` · ${compactDuration(agent.durationMs)}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Format a duration compactly for a chip label.
 * @param milliseconds - Duration in milliseconds.
 * @returns Label like `1.2s`, `2m 13s`, or `1h 04m`.
 */
function compactDuration(milliseconds: number): string {
  const seconds = milliseconds / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}
