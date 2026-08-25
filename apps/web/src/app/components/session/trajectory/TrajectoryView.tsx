/**
 * Trajectory view: compact summary over a turn-aware event ledger.
 *
 * ZeRo OS adaptation of the DeepSeek Harness ui-trajectory view (MIT): the
 * cordis conversation-shell seams (useSession store hooks, injected loadOlder,
 * locale service) are replaced by props; the ledger layout, request numbering,
 * timeline projection, and search index logic are unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type TrajectoryAgentEntry, TrajectoryAgents } from './TrajectoryAgents'
import { type TrajectoryRequestNumber, TrajectoryTable } from './TrajectoryTable'
import { TrajectoryTimeline } from './TrajectoryTimeline'
import { TrajectoryToolbar } from './TrajectoryToolbar'
import { createTrajectoryDurationStore, useSnapshotStoreValue } from './duration-store'
import {
  type TrajectoryTurnModel,
  appendTrajectoryPartialLayout,
  deriveTrajectoryLayout,
} from './layout'
import { createTrajectoryT } from './locales'
import { deriveTrajectoryRequestNumbers } from './request-numbering'
import {
  type TrajectoryTimeRange,
  type TrajectoryTimelineMode,
  trajectoryTimelineFocusIndexes,
} from './timeline'
import { trajectoryRecordId } from './trajectory-record'
import { TrajectorySearchIndex } from './trajectory-search-index'
import type { AssistantBlock, PartialAssistant, TrajectorySnapshot } from './types'
import { EMPTY_TRAJECTORY_SNAPSHOT } from './types'
import './trajectory-theme.css'
import css from './views.module.css'

const EMPTY_TURN_IDS: ReadonlySet<number> = new Set()
const EMPTY_RECORD_IDS: ReadonlySet<string> = new Set()
const SEARCH_INDEX_THROTTLE_MS = 3_000

const durationStore = createTrajectoryDurationStore()
const t = createTrajectoryT()

function lastCellIndex(turns: readonly TrajectoryTurnModel[]): number {
  let last = 0
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const cell of group.cells) last = Math.max(last, cell.index)
    }
  }
  return last
}

function timelineBlock(block: AssistantBlock): AssistantBlock {
  switch (block.kind) {
    case 'text':
      return { kind: 'text', text: '' }
    case 'reasoning':
      return { kind: 'reasoning', text: '' }
    case 'image':
      return block
    case 'tool-call':
      return {
        kind: 'tool-call',
        callId: block.callId,
        name: block.name,
        argsRaw: '',
      }
    case 'other':
      return { kind: 'other', block: null }
  }
}

function partialStructureSignature(partial: PartialAssistant | null): string {
  if (partial === null) return ''
  return partial.blocks
    .map((block) =>
      block.kind === 'tool-call' ? `${block.kind}:${block.callId}:${block.name}` : block.kind,
    )
    .join('\u0000')
}

export interface TrajectoryViewProps {
  /** Trajectory data assembled by the session adapter. */
  snapshot: TrajectorySnapshot | null
  /** Whether the owning session detail is still loading its first payload. */
  loading?: boolean
}

export function TrajectoryView({ snapshot, loading = false }: TrajectoryViewProps) {
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(EMPTY_TURN_IDS)
  const [collapsedAssistants, setCollapsedAssistants] =
    useState<ReadonlySet<string>>(EMPTY_RECORD_IDS)
  const [timelineSelection, setTimelineSelection] = useState<TrajectoryTimeRange | null>(null)
  const actualDuration = useSnapshotStoreValue(durationStore)
  const setActualDuration = useCallback((next: boolean) => {
    durationStore.set(next)
  }, [])
  const [actualTime, setActualTime] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [searchIndex] = useState(() => new TrajectorySearchIndex())
  const [searchIndexRevision, setSearchIndexRevision] = useState(0)
  const searchIndexTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchIndexInitialized = useRef(false)
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState<number | null>(null)
  const [timelineRecordSelection, setTimelineRecordSelection] = useState<{
    readonly index: number
  } | null>(null)
  const [timelineRecordFocus, setTimelineRecordFocus] = useState<{
    readonly index: number
  } | null>(null)
  const inspection = snapshot ?? EMPTY_TRAJECTORY_SNAPSHOT
  const historyLoading = loading
  const olderHistoryLoading = false
  const hasOlderHistory = false
  const nodes = inspection.eventNodes
  const eventLocations = inspection.eventLocations
  const historyBaseSeq = nodes[0]?.seq ?? 0
  const partial = inspection.partial
  const runningCalls = inspection.runningCalls
  const requests = inspection.requests
  const callSchemas = inspection.callSchemas
  const requestNumbers = useMemo<readonly TrajectoryRequestNumber[]>(
    () => deriveTrajectoryRequestNumbers(nodes, requests),
    [nodes, requests],
  )
  const partialTurn = partial?.turn ?? null
  const partialStep = partial?.step ?? null
  const finalized = useMemo(() => {
    const turns = deriveTrajectoryLayout({
      nodes,
      eventLocations,
      partial:
        partialTurn === null || partialStep === null
          ? null
          : { turn: partialTurn, step: partialStep, blocks: [] },
      runningCalls,
      requests,
      callSchemas,
    })
    return { turns, lastIndex: lastCellIndex(turns) }
  }, [nodes, eventLocations, partialTurn, partialStep, runningCalls, requests, callSchemas])
  const timelinePartialSignature = partialStructureSignature(partial)
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt only when the partial's structure changes, not per streamed block
  const timelinePartial = useMemo<PartialAssistant | null>(
    () =>
      partial === null
        ? null
        : {
            turn: partial.turn,
            step: partial.step,
            blocks: partial.blocks.map((block) => timelineBlock(block)),
          },
    [partialStep, partialTurn, timelinePartialSignature],
  )
  const timelineTurns = useMemo(
    () => appendTrajectoryPartialLayout(finalized.turns, timelinePartial, finalized.lastIndex),
    [finalized, timelinePartial],
  )
  // Sub-agent delegation strip: metadata comes from the projected sub-agent
  // nodes, selection resolves the laid cell so the detail pane opens on it.
  const subAgentEntries = useMemo<readonly TrajectoryAgentEntry[]>(() => {
    const entries: TrajectoryAgentEntry[] = []
    for (const node of nodes) {
      if (node.kind !== 'context' || node.form !== 'sub-agent') continue
      const source = node.source as {
        agentId?: unknown
        label?: unknown
        model?: unknown
        status?: unknown
        durationMs?: unknown
        childToolCalls?: unknown
      } | null
      if (source === null || typeof source !== 'object') continue
      if (typeof source.agentId !== 'string') continue
      entries.push({
        agentId: source.agentId,
        label:
          typeof source.label === 'string' && source.label !== '' ? source.label : source.agentId,
        ...(typeof source.model === 'string' && source.model !== '' ? { model: source.model } : {}),
        status: typeof source.status === 'string' ? source.status : 'unknown',
        ...(typeof source.durationMs === 'number' && Number.isFinite(source.durationMs)
          ? { durationMs: source.durationMs }
          : {}),
        toolCount: Array.isArray(source.childToolCalls) ? source.childToolCalls.length : 0,
      })
    }
    return entries
  }, [nodes])
  const subAgentCellIndexes = useMemo(() => {
    const indexByAgentId = new Map<string, number>()
    const agentIdByIndex = new Map<number, string>()
    for (const turn of timelineTurns) {
      for (const group of turn.groups) {
        for (const cell of group.cells) {
          const source = cell.messageSource
          if (typeof source !== 'object' || source === null) continue
          const record = source as { kind?: unknown; agentId?: unknown }
          if (record.kind === 'sub-agent' && typeof record.agentId === 'string') {
            indexByAgentId.set(record.agentId, cell.index)
            agentIdByIndex.set(cell.index, record.agentId)
          }
        }
      }
    }
    return { indexByAgentId, agentIdByIndex }
  }, [timelineTurns])
  const handleSubAgentSelect = useCallback(
    (agentId: string) => {
      const index = subAgentCellIndexes.indexByAgentId.get(agentId)
      if (index === undefined) return
      setTimelineSelection(null)
      setTimelineRecordSelection({ index })
      setSelectedTimelineIndex(index)
    },
    [subAgentCellIndexes],
  )
  const timelineMode: TrajectoryTimelineMode = actualDuration
    ? actualTime
      ? 'actual'
      : 'duration'
    : actualTime
      ? 'time'
      : 'sequence'
  const partialSearchTurns = useMemo(
    () => appendTrajectoryPartialLayout([], partial, finalized.lastIndex),
    [finalized.lastIndex, partial],
  )
  const searchLayouts = useMemo(
    () => [finalized.turns, partialSearchTurns] as const,
    [finalized, partialSearchTurns],
  )
  const latestSearchLayouts = useRef(searchLayouts)
  latestSearchLayouts.current = searchLayouts
  useEffect(() => {
    if (!searchIndexInitialized.current) {
      searchIndexInitialized.current = true
      if (searchIndex.update(searchLayouts)) {
        setSearchIndexRevision((revision) => revision + 1)
      }
      return
    }
    if (searchIndexTimer.current !== null) return
    searchIndexTimer.current = setTimeout(() => {
      searchIndexTimer.current = null
      if (searchIndex.update(latestSearchLayouts.current)) {
        setSearchIndexRevision((revision) => revision + 1)
      }
    }, SEARCH_INDEX_THROTTLE_MS)
  }, [searchIndex, searchLayouts])
  useEffect(
    () => () => {
      if (searchIndexTimer.current !== null) clearTimeout(searchIndexTimer.current)
    },
    [],
  )
  const streamingCells = useMemo(
    () => partialSearchTurns.flatMap((turn) => turn.groups.flatMap((group) => group.cells)),
    [partialSearchTurns],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: searchIndexRevision invalidates results when the index is rebuilt
  const searchMatchRecordIds = useMemo(
    () => searchIndex.search(searchQuery),
    [searchIndex, searchIndexRevision, searchQuery],
  )
  const searchMatchIndexes = useMemo(() => {
    if (searchMatchRecordIds === null) return null
    const indexes = new Set<number>()
    for (const turns of searchLayouts) {
      for (const turn of turns) {
        for (const group of turn.groups) {
          for (const cell of group.cells) {
            if (searchMatchRecordIds.has(trajectoryRecordId(cell))) indexes.add(cell.index)
          }
        }
      }
    }
    return indexes
  }, [searchLayouts, searchMatchRecordIds])
  const timelineRange = timelineSelection
  const timelineFocusIndexes = useMemo(
    () =>
      timelineRange === null
        ? null
        : trajectoryTimelineFocusIndexes(timelineTurns, timelineRange, timelineMode),
    [timelineMode, timelineRange, timelineTurns],
  )
  const handleRecordSelect = useCallback(
    (index: number) => {
      if (timelineFocusIndexes !== null && !timelineFocusIndexes.has(index)) {
        setTimelineSelection(null)
      }
    },
    [timelineFocusIndexes],
  )
  const handleTimelineRangeChange = useCallback((range: TrajectoryTimeRange | null) => {
    setTimelineSelection(range)
  }, [])
  const handleTimelineRecordSelect = useCallback((index: number) => {
    setTimelineSelection(null)
    setTimelineRecordSelection({ index })
    setSelectedTimelineIndex(index)
  }, [])
  const handleTimelineRecordFocus = useCallback((index: number) => {
    setTimelineRecordFocus({ index })
  }, [])
  const collapsibleTurnIds = useMemo(
    () =>
      timelineTurns
        .filter(
          (turn) =>
            turn.turn !== null &&
            turn.groups.reduce(
              (count, group) =>
                count +
                group.cells.filter((cell) => cell.requestOnly !== true && cell.kind !== 'system')
                  .length,
              0,
            ) > 1,
        )
        .flatMap((turn) => (turn.turn === null ? [] : [turn.turn])),
    [timelineTurns],
  )
  const allTurnsCollapsed =
    collapsibleTurnIds.length > 0 && collapsibleTurnIds.every((turn) => collapsedTurns.has(turn))
  const collapsibleAssistantIds = useMemo(() => {
    const ids: string[] = []
    for (const turn of timelineTurns) {
      const cells = turn.groups.flatMap((group) => group.cells)
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i]
        if (cell?.kind !== 'message') continue
        const next = cells[i + 1]
        if (next?.kind === 'tool' || next?.kind === 'subtool') {
          ids.push(trajectoryRecordId(cell))
        }
      }
    }
    return ids
  }, [timelineTurns])
  const allAssistantsCollapsed =
    collapsibleAssistantIds.length > 0 &&
    collapsibleAssistantIds.every((index) => collapsedAssistants.has(index))

  const toggleTurn = (turn: number) => {
    setCollapsedTurns((current) => {
      const collapsed = new Set(current)
      if (collapsed.has(turn)) collapsed.delete(turn)
      else collapsed.add(turn)
      return collapsed
    })
  }

  const toggleAllTurns = () => {
    setCollapsedTurns((current) => {
      const collapsed = new Set(current)
      if (allTurnsCollapsed) {
        for (const turn of collapsibleTurnIds) collapsed.delete(turn)
      } else {
        for (const turn of collapsibleTurnIds) collapsed.add(turn)
      }
      return collapsed
    })
  }

  const toggleAssistant = (id: string) => {
    setCollapsedAssistants((current) => {
      const collapsed = new Set(current)
      if (collapsed.has(id)) collapsed.delete(id)
      else collapsed.add(id)
      return collapsed
    })
  }

  const toggleAllAssistants = () => {
    setCollapsedAssistants((current) => {
      const collapsed = new Set(current)
      if (allAssistantsCollapsed) {
        for (const index of collapsibleAssistantIds) collapsed.delete(index)
      } else {
        for (const index of collapsibleAssistantIds) collapsed.add(index)
      }
      return collapsed
    })
  }

  const loadEarlierHistory = useCallback(async () => false, [])

  return (
    <div className={`trajectory-theme ${css.root}`}>
      <TrajectoryToolbar
        actualDuration={actualDuration}
        onActualDurationChange={(nextActualDuration) => {
          setActualDuration(nextActualDuration)
          setTimelineSelection(null)
        }}
        actualTime={actualTime}
        onActualTimeChange={(nextActualTime) => {
          setActualTime(nextActualTime)
          setTimelineSelection(null)
        }}
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={toggleAllTurns}
        allAssistantsCollapsed={allAssistantsCollapsed}
        onToggleAllAssistants={toggleAllAssistants}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        subAgentCount={subAgentEntries.length}
        agentsOpen={agentsOpen}
        onToggleAgents={() => {
          setAgentsOpen((open) => !open)
        }}
        t={t}
      />
      {agentsOpen && subAgentEntries.length > 0 ? (
        <TrajectoryAgents
          agents={subAgentEntries}
          selectedAgentId={
            timelineRecordSelection === null
              ? null
              : (subAgentCellIndexes.agentIdByIndex.get(timelineRecordSelection.index) ?? null)
          }
          onSelect={handleSubAgentSelect}
          ariaLabel={t('agents.aria')}
        />
      ) : null}
      <TrajectoryTimeline
        turns={timelineTurns}
        mode={timelineMode}
        range={timelineRange}
        hasEarlierRecords={hasOlderHistory}
        onLoadEarlier={loadEarlierHistory}
        selectedIndex={selectedTimelineIndex}
        searchMatchIndexes={searchMatchIndexes}
        onRangeChange={handleTimelineRangeChange}
        onRecordSelect={handleTimelineRecordSelect}
        onRecordFocus={handleTimelineRecordFocus}
      />
      <div className={css.ledger}>
        <TrajectoryTable
          requestNumbers={requestNumbers}
          turns={timelineTurns}
          streamingCells={streamingCells}
          timelineFocusIndexes={timelineFocusIndexes}
          searchMatchIndexes={searchMatchIndexes}
          onSelectedIndexChange={setSelectedTimelineIndex}
          onRecordSelect={handleRecordSelect}
          recordSelection={timelineRecordSelection}
          recordFocus={timelineRecordFocus}
          historyLoading={historyLoading}
          olderHistoryLoading={olderHistoryLoading}
          historyStartSeq={historyBaseSeq}
          hasOlderRecords={hasOlderHistory}
          onLoadOlder={loadEarlierHistory}
          onClearSelection={() => {
            setTimelineSelection(null)
          }}
          collapsedTurns={collapsedTurns}
          onToggleTurn={toggleTurn}
          collapsedAssistants={collapsedAssistants}
          onToggleAssistant={toggleAssistant}
          inspectCallId={null}
          onInspectApplied={undefined}
        />
      </div>
    </div>
  )
}
