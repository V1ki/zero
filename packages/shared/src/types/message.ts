import type { ReasoningEffort } from './reasoning'

export type MessageRole = 'user' | 'assistant' | 'system'

export type MessageType = 'message' | 'notification' | 'queued' | 'control'

export type ControlKind =
  | 'task_closure'
  | 'continuation'
  | 'memory_nudge'
  | 'empty_retry'
  | 'queued_injection'

export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking'

export type ToolEvidenceKind = 'tool_use_input' | 'tool_result_output'

export interface ToolEvidence {
  kind: ToolEvidenceKind
  sessionId: string
  toolUseId: string
  toolName: string
  path: string
  chars: number
  bytes: number
  sha256: string
  createdAt: string
  summary?: string
  strategy?: string
  writeStatus?: 'created' | 'existing'
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  evidence?: ToolEvidence
}

export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content: string
  contentItems?: ToolResultContentItem[]
  isError?: boolean
  outputSummary?: string
  evidence?: ToolEvidence
  /** Tracks the truncation level applied to this block for cache-friendly idempotency */
  truncationLevel?: 'full' | 'summary' | 'status'
}

export interface ImageBlock {
  type: 'image'
  mediaType: string
  data: string
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export type ToolResultContentItem = TextBlock | ImageBlock

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | ThinkingBlock

export interface Message {
  id: string
  sessionId: string
  role: MessageRole
  messageType: MessageType
  controlKind?: ControlKind
  taskClosure?: {
    action: 'finish' | 'continue' | 'block'
    reason: string
  }
  content: ContentBlock[]
  model?: string
  createdAt: string
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens'

export interface TokenUsage {
  input: number
  output: number
  cacheWrite?: number
  cacheRead?: number
  reasoning?: number
}

export interface CompletionRequestMeta {
  sessionId: string
  purpose: string
  parentSessionId?: string
}

export interface CompletionRequest {
  messages: Message[]
  tools?: ToolDefinition[]
  system?: string
  stream: boolean
  maxTokens?: number
  model?: string
  reasoningEffort?: ReasoningEffort
  meta?: CompletionRequestMeta
}

export interface CompletionResponse {
  id: string
  content: ContentBlock[]
  stopReason: StopReason
  usage: TokenUsage
  model: string
  reasoningContent?: string
}

export type StreamEventType =
  | 'text_delta'
  | 'reasoning_delta'
  | 'reasoning_signature'
  | 'tool_use_start'
  | 'tool_use_delta'
  | 'tool_use_end'
  | 'done'
  | 'error'

export interface StreamEvent {
  type: StreamEventType
  data: unknown
}

export type ToolKind = 'built-in' | 'tool' | 'mcp'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  kind?: ToolKind
}
