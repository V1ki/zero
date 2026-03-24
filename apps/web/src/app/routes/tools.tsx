import type { ToolKind } from '@zero-os/shared'
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import { Skeleton } from '../components/shared/Skeleton'
import { apiFetch } from '../lib/api'
import { useUIStore } from '../stores/ui'

interface ToolInfo {
  name: string
  description: string
  parameters: Record<string, unknown>
  kind?: ToolKind
  enabled?: boolean
}

type Filter = 'all' | ToolKind

const TYPE_STYLES: Record<ToolKind, { bg: string; text: string }> = {
  'built-in': { bg: 'bg-cyan-400/10', text: 'text-cyan-400' },
  tool: { bg: 'bg-emerald-400/10', text: 'text-emerald-400' },
  mcp: { bg: 'bg-violet-400/10', text: 'text-violet-400' },
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'built-in', label: 'Built-in' },
  { key: 'tool', label: 'Tool' },
  { key: 'mcp', label: 'MCP' },
]

export function ToolsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [disabledTools, setDisabledTools] = useState<Set<string>>(new Set())
  const [confirmDisable, setConfirmDisable] = useState<string | null>(null)
  const { addToast } = useUIStore()

  useEffect(() => {
    apiFetch<{ tools: ToolInfo[] }>('/api/tools')
      .then((res) => {
        setTools(res.tools)
        const disabled = new Set<string>()
        for (const t of res.tools) {
          if (t.enabled === false) disabled.add(t.name)
        }
        setDisabledTools(disabled)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  function toggleExpand(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function requestToggle(name: string) {
    const isCurrentlyEnabled = !disabledTools.has(name)
    if (isCurrentlyEnabled) {
      setConfirmDisable(name)
    } else {
      doToggle(name)
    }
  }

  function doToggle(name: string) {
    const wasDisabled = disabledTools.has(name)
    setDisabledTools((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
    addToast('success', wasDisabled ? `${name} 已启用` : `${name} 已禁用`)
    setConfirmDisable(null)
  }

  const filtered = filter === 'all' ? tools : tools.filter((t) => (t.kind ?? 'tool') === filter)

  const enabledTools = filtered.filter((t) => !disabledTools.has(t.name))
  const disabledList = filtered.filter((t) => disabledTools.has(t.name))

  function renderToolCard(tool: ToolInfo) {
    const type = tool.kind ?? 'tool'
    const style = TYPE_STYLES[type]
    const isEnabled = !disabledTools.has(tool.name)
    const isExpanded = expanded.has(tool.name)

    return (
      <div key={tool.name} className="card p-5 animate-fade-up">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
              {tool.name}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${style.bg} ${style.text}`}>
              {type}
            </span>
          </div>
          {/* Toggle switch */}
          <button
            type="button"
            onClick={() => requestToggle(tool.name)}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              isEnabled ? 'bg-[var(--color-accent)]' : 'bg-white/[0.1]'
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                isEnabled ? 'left-[18px]' : 'left-0.5'
              }`}
            />
          </button>
        </div>
        <p className="text-[13px] text-[var(--color-text-secondary)] mb-3">{tool.description}</p>
        {tool.parameters && Object.keys(tool.parameters).length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => toggleExpand(tool.name)}
              className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
            >
              {isExpanded ? 'Hide parameters' : 'Show parameters'}
            </button>
            {isExpanded && (
              <div className="bg-white/[0.02] rounded-lg p-3 mt-2">
                <pre className="text-[11px] font-mono text-[var(--color-text-disabled)] whitespace-pre-wrap overflow-auto max-h-[200px]">
                  {JSON.stringify(tool.parameters, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <h1 className="text-[20px] font-bold tracking-tight mb-4">Tools</h1>

      {/* Filter tabs */}
      <div className="flex gap-1.5 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`px-4 py-1.5 rounded-md text-[13px] transition-colors ${
              filter === f.key
                ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 6 }, (_, index) => `tool-loading-${index}`).map((key) => (
            <div key={key} className="card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-14 rounded" />
              </div>
              <Skeleton className="h-3 w-full mb-2" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          ))}
        </div>
      ) : tools.length === 0 ? (
        <div className="card p-8 text-center text-[13px] text-[var(--color-text-muted)]">
          No tools registered
        </div>
      ) : (
        <div className="space-y-6">
          {/* Enabled tools */}
          {enabledTools.length > 0 && (
            <div>
              <h2 className="text-[12px] font-semibold text-[var(--color-text-muted)] tracking-wide mb-3">
                ENABLED TOOLS ({enabledTools.length})
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {enabledTools.map(renderToolCard)}
              </div>
            </div>
          )}

          {/* Disabled tools */}
          {disabledList.length > 0 && (
            <div>
              <h2 className="text-[12px] font-semibold text-[var(--color-text-muted)] tracking-wide mb-3">
                DISABLED TOOLS ({disabledList.length})
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 opacity-60">
                {disabledList.map(renderToolCard)}
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDisable !== null}
        title={`禁用 ${confirmDisable}？`}
        description="禁用后该工具将不可被 Agent 使用，可随时重新启用。"
        confirmText="禁用"
        danger
        onConfirm={() => {
          if (confirmDisable) doToggle(confirmDisable)
        }}
        onCancel={() => setConfirmDisable(null)}
      />
    </div>
  )
}
