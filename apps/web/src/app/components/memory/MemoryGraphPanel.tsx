import { useCallback, useMemo, useRef, useState } from 'react'
import type { MemoryItem } from '../../routes/memory'
import { type GraphNode, buildMemoryGraph, computeForceLayout } from './graph'

const TYPE_HEX: Record<string, string> = {
  session: '#22d3ee',
  incident: '#f87171',
  runbook: '#34d399',
  decision: '#fbbf24',
  note: '#60a5fa',
  preference: '#a78bfa',
  inbox: '#f472b6',
}

const HEAT_STROKE: Record<GraphNode['heat'], string> = {
  hot: '#22d3ee',
  cold: '#f59e0b',
  never: 'rgba(255,255,255,0.18)',
}

const NODE_LIMIT = 260
const CANVAS_W = 1440
const CANVAS_H = 820

interface UsageEntry {
  id: string
  score: number
  total: number
  lastAccessedAt: string
}

interface HoverState {
  node: GraphNode
  cx: number
  cy: number
}

/**
 * 记忆关系图:节点=记忆(颜色=类型,半径/描边=使用热度),实线箭头=取代/并入谱系,
 * 虚线=显式关联边。布局在数据变化时同步计算一次;拖拽单节点、拖背景平移、滚轮缩放。
 */
export function MemoryGraphPanel({
  memories,
  usageById,
  selectedId,
  onSelectMemory,
}: {
  memories: MemoryItem[]
  usageById: Record<string, UsageEntry>
  selectedId: string | null
  onSelectMemory: (memory: MemoryItem) => void
}) {
  const [includeIsolated, setIncludeIsolated] = useState(false)
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 })
  const [dragged, setDragged] = useState<string | null>(null)
  const [pinned, setPinned] = useState<Record<string, { x: number; y: number }>>({})
  const [hover, setHover] = useState<HoverState | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const panRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  )
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null)

  const { nodes, links, truncated } = useMemo(() => {
    const graph = buildMemoryGraph(memories, usageById, { includeIsolated })
    if (graph.nodes.length <= NODE_LIMIT) {
      return { ...graph, truncated: false }
    }
    // 超上限时保留连线最多/使用最热的节点,保证图上呈现的是"关系最密"的子图
    const keep = new Set(
      [...graph.nodes]
        .sort((a, b) => b.degree - a.degree || b.usageScore - a.usageScore)
        .slice(0, NODE_LIMIT)
        .map((node) => node.id),
    )
    return {
      nodes: graph.nodes.filter((node) => keep.has(node.id)),
      links: graph.links.filter((link) => keep.has(link.source) && keep.has(link.target)),
      truncated: true,
    }
  }, [memories, usageById, includeIsolated])

  const layout = useMemo(
    () => computeForceLayout(nodes, links, { width: CANVAS_W, height: CANVAS_H }),
    [nodes, links],
  )
  const positions = useMemo(() => {
    const merged = new Map(layout)
    for (const [id, point] of Object.entries(pinned)) merged.set(id, point)
    return merged
  }, [layout, pinned])

  const byId = useMemo(() => new Map(memories.map((memory) => [memory.id, memory])), [memories])

  const toSvgCoords = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }
      const scaleX = CANVAS_W / rect.width
      const scaleY = CANVAS_H / rect.height
      return {
        x: ((clientX - rect.left) * scaleX - transform.x) / transform.k,
        y: ((clientY - rect.top) * scaleY - transform.y) / transform.k,
      }
    },
    [transform],
  )

  function handleNodePointerDown(event: React.PointerEvent, nodeId: string) {
    event.stopPropagation()
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
    dragRef.current = { startX: event.clientX, startY: event.clientY, moved: false }
    setDragged(nodeId)
  }

  function handlePointerMove(event: React.PointerEvent) {
    const point = toSvgCoords(event.clientX, event.clientY)
    if (dragged) {
      const start = dragRef.current
      if (start && Math.hypot(event.clientX - start.startX, event.clientY - start.startY) > 3) {
        start.moved = true
      }
      setPinned((prev) => ({ ...prev, [dragged]: point }))
      return
    }
    if (panRef.current) {
      const pan = panRef.current
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect) return
      const scaleX = CANVAS_W / rect.width
      const scaleY = CANVAS_H / rect.height
      setTransform((prev) => ({
        ...prev,
        x: pan.baseX + (event.clientX - pan.startX) * scaleX,
        y: pan.baseY + (event.clientY - pan.startY) * scaleY,
      }))
    }
  }

  function handlePointerUp(nodeId?: string) {
    if (dragged && nodeId) {
      const start = dragRef.current
      const clicked = !start?.moved
      dragRef.current = null
      setDragged(null)
      if (clicked) {
        const memory = byId.get(nodeId)
        if (memory) onSelectMemory(memory)
      }
      return
    }
    if (nodeId === undefined) {
      panRef.current = null
      dragRef.current = null
      setDragged(null)
    }
  }

  function handleWheel(event: React.WheelEvent) {
    event.preventDefault()
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const mouseX = ((event.clientX - rect.left) * CANVAS_W) / rect.width
    const mouseY = ((event.clientY - rect.top) * CANVAS_H) / rect.height
    setTransform((prev) => {
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
      const k = Math.min(4, Math.max(0.35, prev.k * factor))
      // 缩放围绕光标:保持光标下的图坐标不动
      return {
        k,
        x: mouseX - ((mouseX - prev.x) / prev.k) * k,
        y: mouseY - ((mouseY - prev.y) / prev.k) * k,
      }
    })
  }

  function resetView() {
    setTransform({ x: 0, y: 0, k: 1 })
    setPinned({})
  }

  const lineageLinks = links.filter((link) => link.category === 'lineage')
  const edgeLinks = links.filter((link) => link.category === 'edge')
  const hotCount = nodes.filter((node) => node.heat === 'hot').length
  const neverCount = nodes.filter((node) => node.heat === 'never').length

  return (
    <div className="card p-3 flex flex-col gap-2 min-h-[680px]">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap text-[10px] text-[var(--color-text-muted)]">
          {Object.entries(TYPE_HEX).map(([type, hex]) => (
            <span key={type} className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: hex }} />
              {type}
            </span>
          ))}
          <span className="inline-flex items-center gap-1 ml-2">
            <svg width="22" height="6" role="img" aria-label="取代/并入连线">
              <title>取代/并入连线</title>
              <line x1="0" y1="3" x2="22" y2="3" stroke="#fbbf24" strokeWidth="1.4" />
            </svg>
            取代/并入
          </span>
          <span className="inline-flex items-center gap-1">
            <svg width="22" height="6" role="img" aria-label="显式关联连线">
              <title>显式关联连线</title>
              <line
                x1="0"
                y1="3"
                x2="22"
                y2="3"
                stroke="#38bdf8"
                strokeWidth="1.2"
                strokeDasharray="4 3"
              />
            </svg>
            显式关联
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full inline-block border border-[#22d3ee]" />热{' '}
            {hotCount}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full inline-block border border-[rgba(255,255,255,0.18)]" />
            未用 {neverCount}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {truncated && (
            <span className="text-[10px] text-amber-400/80">
              节点过多,已截取关系最密的 {NODE_LIMIT} 个
            </span>
          )}
          <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={includeIsolated}
              onChange={(event) => setIncludeIsolated(event.target.checked)}
              className="accent-cyan-400"
            />
            含孤立节点
          </label>
          <button
            type="button"
            onClick={resetView}
            className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
          >
            重置视图
          </button>
        </div>
      </div>

      <div className="relative flex-1">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          role="img"
          aria-label="记忆关系图"
          className="block h-auto w-full touch-none select-none cursor-grab"
          onWheel={handleWheel}
          onPointerDown={(event) => {
            panRef.current = {
              startX: event.clientX,
              startY: event.clientY,
              baseX: transform.x,
              baseY: transform.y,
            }
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={() => handlePointerUp()}
          onPointerLeave={() => {
            panRef.current = null
            setHover(null)
            setDragged(null)
          }}
        >
          <defs>
            <marker
              id="lineage-arrow"
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#fbbf24" opacity="0.8" />
            </marker>
          </defs>
          <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
            {lineageLinks.map((link) => {
              const a = positions.get(link.source)
              const b = positions.get(link.target)
              if (!a || !b) return null
              return (
                <line
                  key={link.key}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="#fbbf24"
                  strokeWidth={1.4}
                  strokeOpacity={0.55}
                  markerEnd="url(#lineage-arrow)"
                />
              )
            })}
            {edgeLinks.map((link) => {
              const a = positions.get(link.source)
              const b = positions.get(link.target)
              if (!a || !b) return null
              return (
                <line
                  key={link.key}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="#38bdf8"
                  strokeWidth={1.1}
                  strokeOpacity={0.4}
                  strokeDasharray="5 4"
                />
              )
            })}
            {nodes.map((node) => {
              const point = positions.get(node.id)
              if (!point) return null
              const radius = 5 + 9 * node.usageScore
              const isSelected = node.id === selectedId
              const isArchived = node.status === 'archived'
              return (
                <g
                  key={node.id}
                  opacity={isArchived ? 0.45 : 1}
                  onPointerDown={(event) => handleNodePointerDown(event, node.id)}
                  onPointerUp={() => handlePointerUp(node.id)}
                  onPointerEnter={() => setHover({ node, cx: point.x, cy: point.y - radius })}
                  onPointerLeave={() => setHover(null)}
                  className="cursor-pointer"
                >
                  {isSelected && (
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r={radius + 5}
                      fill="none"
                      stroke="#e2e8f0"
                      strokeWidth={1.2}
                      strokeOpacity={0.9}
                    />
                  )}
                  {node.heat === 'hot' && (
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r={radius + 3}
                      fill="#22d3ee"
                      opacity={0.12}
                    />
                  )}
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={radius}
                    fill={TYPE_HEX[node.type] ?? '#94a3b8'}
                    fillOpacity={isArchived ? 0.5 : 0.85}
                    stroke={HEAT_STROKE[node.heat]}
                    strokeWidth={node.heat === 'never' ? 1 : 1.8}
                    strokeDasharray={isArchived ? '3 2' : undefined}
                  />
                  {(transform.k > 1.4 || node.degree >= 3 || isSelected) && (
                    <text
                      x={point.x}
                      y={point.y + radius + 11}
                      textAnchor="middle"
                      fontSize={9}
                      fill="rgba(226,232,240,0.75)"
                      style={{ pointerEvents: 'none' }}
                    >
                      {node.title.length > 14 ? `${node.title.slice(0, 13)}…` : node.title}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>

        {hover && (
          <div
            className="pointer-events-none absolute z-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated,rgba(15,23,42,0.95))] px-3 py-2 shadow-xl"
            style={{
              left: `${Math.min(70, Math.max(2, (hover.cx / CANVAS_W) * 100))}%`,
              top: `${Math.max(2, (hover.cy / CANVAS_H) * 100 - 8)}%`,
            }}
          >
            <p className="text-[12px] font-semibold text-[var(--color-text-primary)] max-w-[260px] truncate">
              {hover.node.title}
            </p>
            <p className="text-[10px] font-mono text-[var(--color-text-muted)] mt-0.5">
              {hover.node.type} · {hover.node.status} · 关联 {hover.node.degree}
            </p>
            <p className="text-[10px] font-mono text-[var(--color-text-muted)]">
              {hover.node.heat === 'never'
                ? '从未使用'
                : `usage ${(hover.node.usageScore * 100).toFixed(0)}% · 累计 ${hover.node.total}`}
            </p>
          </div>
        )}

        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[12px] text-[var(--color-text-disabled)]">
              记忆之间还没有任何取代/合并/关联关系 —— 在详情页建立关联,或等会话评估自动沉淀
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
