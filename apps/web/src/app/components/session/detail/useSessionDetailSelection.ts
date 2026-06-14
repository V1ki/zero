import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

interface SessionDetailSelectionState {
  timelineRef: RefObject<HTMLDivElement | null>
  selectedToolId: string | null
  selectedDecisionId: string | null
  selectedTaskClosureId: string | null
  selectedMemoryNudgeId: string | null
  selectedSubAgentId: string | null
  highlightedAssistantMessageId: string | null
  highlightedSubAgentId: string | null
  handleSelectTool(toolId: string | null): void
  handleSelectDecision(decisionId: string | null): void
  handleSelectTaskClosure(taskClosureId: string | null): void
  handleSelectMemoryNudge(memoryNudgeId: string | null): void
  handleSelectSubAgent(subAgentId: string | null): void
  jumpToAssistantMessage(messageId: string): void
  handleJumpToSubAgentInTimeline(subAgentId: string): void
}

export function useSessionDetailSelection(
  sessionId: string | null | undefined,
): SessionDetailSelectionState {
  const timelineRef = useRef<HTMLDivElement>(null)
  const lastKeyRef = useRef<string>('')
  const previousSessionIdRef = useRef<string | null | undefined>(undefined)
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null)
  const [selectedTaskClosureId, setSelectedTaskClosureId] = useState<string | null>(null)
  const [selectedMemoryNudgeId, setSelectedMemoryNudgeId] = useState<string | null>(null)
  const [selectedSubAgentId, setSelectedSubAgentId] = useState<string | null>(null)
  const [highlightedAssistantMessageId, setHighlightedAssistantMessageId] = useState<string | null>(
    null,
  )
  const [highlightedSubAgentId, setHighlightedSubAgentId] = useState<string | null>(null)

  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return
    previousSessionIdRef.current = sessionId
    setSelectedToolId(null)
    setSelectedDecisionId(null)
    setSelectedTaskClosureId(null)
    setSelectedMemoryNudgeId(null)
    setSelectedSubAgentId(null)
    setHighlightedAssistantMessageId(null)
    setHighlightedSubAgentId(null)
  }, [sessionId])

  const handleSelectTool = useCallback((toolId: string | null) => {
    setSelectedToolId(toolId)
  }, [])

  const handleSelectDecision = useCallback((decisionId: string | null) => {
    setSelectedDecisionId(decisionId)
    setSelectedTaskClosureId(null)
    setSelectedMemoryNudgeId(null)
    setSelectedSubAgentId(null)
  }, [])

  const handleSelectTaskClosure = useCallback((taskClosureId: string | null) => {
    setSelectedTaskClosureId(taskClosureId)
    setSelectedDecisionId(null)
    setSelectedMemoryNudgeId(null)
    setSelectedSubAgentId(null)
  }, [])

  const handleSelectMemoryNudge = useCallback((memoryNudgeId: string | null) => {
    setSelectedMemoryNudgeId(memoryNudgeId)
    setSelectedDecisionId(null)
    setSelectedTaskClosureId(null)
    setSelectedSubAgentId(null)
  }, [])

  const handleSelectSubAgent = useCallback((subAgentId: string | null) => {
    setSelectedSubAgentId(subAgentId)
    setSelectedDecisionId(null)
    setSelectedTaskClosureId(null)
    setSelectedMemoryNudgeId(null)
  }, [])

  const jumpToAssistantMessage = useCallback((messageId: string) => {
    setHighlightedAssistantMessageId(messageId)

    requestAnimationFrame(() => {
      const container = timelineRef.current
      const target = container?.querySelector(
        `[data-assistant-message-id="${messageId}"]`,
      ) as HTMLElement | null
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [])

  const handleJumpToSubAgentInTimeline = useCallback((subAgentId: string) => {
    setSelectedSubAgentId(subAgentId)
    setHighlightedSubAgentId(subAgentId)

    requestAnimationFrame(() => {
      const container = timelineRef.current
      const target = container?.querySelector(
        `[data-sub-agent-id="${subAgentId}"]`,
      ) as HTMLElement | null
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [])

  useEffect(() => {
    if (!highlightedAssistantMessageId) return
    const timer = setTimeout(() => setHighlightedAssistantMessageId(null), 3000)
    return () => clearTimeout(timer)
  }, [highlightedAssistantMessageId])

  useEffect(() => {
    if (!highlightedSubAgentId) return
    const timer = setTimeout(() => setHighlightedSubAgentId(null), 3000)
    return () => clearTimeout(timer)
  }, [highlightedSubAgentId])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const el = timelineRef.current
    if (!el) return

    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    const scrollAmount = 60

    if (e.key === 'j') {
      el.scrollBy({ top: scrollAmount, behavior: 'smooth' })
    } else if (e.key === 'k') {
      el.scrollBy({ top: -scrollAmount, behavior: 'smooth' })
    } else if (e.key === 'Escape') {
      setSelectedToolId(null)
      setSelectedDecisionId(null)
      setSelectedTaskClosureId(null)
      setSelectedSubAgentId(null)
    } else if (e.key === 'g' && lastKeyRef.current === 'g') {
      el.scrollTo({ top: 0, behavior: 'smooth' })
    } else if (e.key === 'G') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }

    lastKeyRef.current = e.key
  }, [])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return {
    timelineRef,
    selectedToolId,
    selectedDecisionId,
    selectedTaskClosureId,
    selectedMemoryNudgeId,
    selectedSubAgentId,
    highlightedAssistantMessageId,
    highlightedSubAgentId,
    handleSelectTool,
    handleSelectDecision,
    handleSelectTaskClosure,
    handleSelectMemoryNudge,
    handleSelectSubAgent,
    jumpToAssistantMessage,
    handleJumpToSubAgentInTimeline,
  }
}
