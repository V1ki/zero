import type { CompletionResponse } from '@zero-os/shared'

export type SessionJudgeDimensionKey =
  | 'task_completion'
  | 'context_management'
  | 'memory_usage'
  | 'evidence_grounding'
  | 'tool_efficiency'
  | 'cost_efficiency'
  | 'human_intervention'
  | 'recovery_honesty'

export interface SessionJudgeDimension {
  key: SessionJudgeDimensionKey
  label: string
  score: number
  maxScore: number
  rationale: string
}

export interface SessionJudgeFinding {
  severity: 'info' | 'warn' | 'bad'
  title: string
  evidence: string
}

export interface SessionJudgeSignals {
  totalCost: number
  requestCount: number
  toolCallCount: number
  duplicateToolCallCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  closureCount: number
}

export interface SessionJudgeResult {
  overallScore: number
  verdict: 'strong' | 'mixed' | 'weak'
  confidence: 'high' | 'medium' | 'low'
  summary: string
  dimensions: SessionJudgeDimension[]
  findings: SessionJudgeFinding[]
  signals: SessionJudgeSignals
}

export interface SessionJudgeResponse {
  sessionId: string
  model: string
  generatedAt: string
  result: SessionJudgeResult
}

export interface SessionJudgeExchangeRequest {
  systemPrompt: string
  userPrompt: string
  model?: string
  maxTokens?: number
  stream: false
}

export interface SessionJudgeExchangeResponse {
  completion: CompletionResponse
  rawText: string
}

export interface SessionJudgeExchangeArtifacts {
  request: SessionJudgeExchangeRequest
  response: SessionJudgeExchangeResponse
}

export interface SessionJudgeArtifacts {
  primary: SessionJudgeExchangeArtifacts
  repair?: SessionJudgeExchangeArtifacts
}

export interface SessionJudgeRunOutput {
  run: SessionJudgeResponse
  artifacts: SessionJudgeArtifacts
}

export interface StoredSessionJudgeEntry {
  version: 1
  savedAt: string
  sessionId: string
  run: SessionJudgeResponse
  artifacts: SessionJudgeArtifacts
}

export interface SessionJudgeHistoryResponse {
  sessionId: string
  history: StoredSessionJudgeEntry[]
}
