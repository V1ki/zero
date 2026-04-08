import type { Message } from '@zero-os/shared'
import { KNOWN_EPISODE_TRAITS } from './types'
import type { ClosureLogEntry, DecisionLogEntry, RequestLogEntry, SnapshotEntry } from '../index'

const QUEUED_WRAPPER_PATTERNS = [
  /^<queued_message>[\s\S]*<\/queued_message>$/u,
  /^<queued_messages(?:\s+[^>]*)?>[\s\S]*<\/queued_messages>$/u,
]

export interface TraitDerivationInput {
  messages: Message[]
  userTurnCount: number
  requests: RequestLogEntry[]
  closures: ClosureLogEntry[]
  decisions: DecisionLogEntry[]
  snapshots: SnapshotEntry[]
}

export function isPureToolResultCarrier(message: Message): boolean {
  return (
    message.role === 'user' &&
    message.messageType === 'message' &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === 'tool_result')
  )
}

export function isQueuedWrapperOnlyMessage(message: Message): boolean {
  if (message.role !== 'user' || message.messageType !== 'message') return false
  if (message.content.length === 0) return false
  if (message.content.some((block) => block.type !== 'text')) return false

  const text = message.content
    .filter((block): block is Extract<Message['content'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (!text) return false

  return QUEUED_WRAPPER_PATTERNS.some((pattern) => pattern.test(text))
}

export function isRealUserTurn(message: Message): boolean {
  return (
    message.role === 'user' &&
    message.messageType === 'message' &&
    !isPureToolResultCarrier(message) &&
    !isQueuedWrapperOnlyMessage(message)
  )
}

export function countUserTurns(messages: Message[]): number {
  return messages.filter(isRealUserTurn).length
}

export function countAssistantTurns(messages: Message[]): number {
  return messages.filter(
    (message) => message.role === 'assistant' && message.messageType === 'message',
  ).length
}

export function deriveTraits(input: TraitDerivationInput): string[] {
  const traits = new Set<string>()

  if (input.requests.some((request) => request.toolCalls.length > 0)) {
    traits.add('uses-tools')
  }

  if (
    input.decisions.some(
      (decision) =>
        decision.decisionType === 'memory_retrieval' && decision.outcome === 'injected',
    )
  ) {
    traits.add('uses-memory-retrieval')
  }

  if (
    input.requests.some((request) => request.toolCalls.some((toolCall) => toolCall.name === 'memory'))
  ) {
    traits.add('uses-memory-write')
  }

  if (
    input.closures.some(
      (closure) => 'action' in closure && closure.event === 'task_closure_decision' && closure.action === 'finish',
    )
  ) {
    traits.add('has-closure-finish')
  }

  if (
    input.closures.some(
      (closure) => 'action' in closure && closure.event === 'task_closure_decision' && closure.action === 'block',
    )
  ) {
    traits.add('has-closure-block')
  }

  if (input.snapshots.some((snapshot) => snapshot.trigger === 'context_compression')) {
    traits.add('has-compression')
  }

  if (input.requests.some((request) => request.spawnedByRequestId)) {
    traits.add('has-sub-agent')
  }

  if (input.userTurnCount > 1) {
    traits.add('multi-turn')
  }

  if (input.requests.some((request) => request.toolResults.some((result) => result.isError))) {
    traits.add('has-tool-errors')
  }

  if (input.requests.some((request) => request.queuedInjection)) {
    traits.add('has-queued-injection')
  }

  if (input.messages.some((message) => message.content.some((block) => block.type === 'image'))) {
    traits.add('has-images')
  }

  return KNOWN_EPISODE_TRAITS.filter((trait) => traits.has(trait))
}
