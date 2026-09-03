import type { Message } from '@zero-os/shared'

export { MemoryStore } from './store'
export type { MemoryRepository } from './store'
export { MemoManager } from './memo'
export { MemoryRetriever } from './retrieval'
export type { MemoryRetrieverConfig } from './retrieval'
export type { ScoredMemoryMatch } from '@zero-os/shared'
export { MemoryLifecycle } from './lifecycle'
export {
  runMemoryRetrievalAgent,
  runMemoryRetrievalAgentDetailed,
} from './retrieval-agent'
export type {
  MemoryRetrievalAgentOptions,
  MemoryRetrievalAgentRun,
  RetrievedMemoryMatch,
} from './retrieval-agent'
export { EmbeddingClient } from './embedding'
export type { EmbeddingConfig, EmbeddingProvider } from './embedding'
export {
  EmbeddingEmptyResultError,
  EmbeddingPayloadError,
  EmbeddingRequestError,
} from './embedding'
export { VectorIndex } from './vector-index'
export type { MemoryVectorMeta, VectorIndexLike } from './vector-index'
export { IndexedMemoryStore } from './indexed-store'
export { computeMemoryClusters, getMemoryClusters, invalidateClusterCache } from './clustering'
export type { ClusterMember, MemoryCluster, ClusterResult } from './clustering'
export { MemoryGovernanceService } from './governance'
export type {
  MemoryGovernanceErrorStatus,
  MemoryGovernanceResult,
  MemoryNeighbor,
  MemoryNeighborResult,
  MemoryRelatedResult,
  MemoryRelationRemoveSpec,
} from './governance'
export { buildMemoryLineage, computeRelatedMemories } from './related'
export type {
  LineageEntry,
  LineageRelation,
  RelatedMemoryHit,
  RelatedReason,
} from './related'
export { MemoryUsageTracker } from './usage-stats'
export type {
  MemoryUsageSnapshotEntry,
  MemoryUsageTrackerOptions,
} from './usage-stats'
export { detectMemoryEcho } from './echo'
export type { EchoMemoryInput, detectMemoryEchoOptions } from './echo'

export const SESSION_MEMORY_PROMPT = `<system_notice>
当前会话即将结束。请回顾整场对话，判断是否需要创建 session 类型的记忆。

判断标准：
- 如果这场对话只是简单问候、闲聊、或单次简单问答，不需要记忆，直接回复"无需记忆"。
- 如果对话有实质性内容（解决了问题、完成了任务、进行了有意义的讨论），使用 memory 工具创建一条 session 类型的记忆。

创建 session 记忆时：
- title：简洁描述这场对话的主题（不要用 sessionId）
- content：2-5 句话总结对话的目标、关键活动和结果
- tags：2-4 个语义标签（如 deploy、bug-fix、refactor、research）

注意：
- 只创建 session 类型的记忆，其他类型（decision、incident、note 等）不在此处处理
- 保持总结简洁，只保留跨会话有参考价值的信息
</system_notice>`

export const MEMORY_NUDGE_PROMPT = `<system_notice>
当前阶段已完成。请快速评估：本次交互是否产生了值得跨会话保留的信息？
- 用户偏好或习惯 → memory create preference
- 技术/业务决策及理由 → memory create decision
- 可复用操作流程 → memory create runbook
- 值得复盘的故障案例 → memory create incident
- 其他长期有参考价值的事实或结论 → memory create note
如果没有值得保留的信息，直接结束即可，不需要回复。
</system_notice>`

export function shouldEvaluateSessionMemory(
  messages: Message[],
  isTopLevelUserTurn: (message: Message) => boolean,
): boolean {
  const userTurns = messages.filter(isTopLevelUserTurn)
  if (userTurns.length <= 1) return false

  const toolCallCount = messages.reduce((count, message) => {
    return count + message.content.filter((block) => block.type === 'tool_use').length
  }, 0)
  if (toolCallCount === 0 && userTurns.length <= 2) return false

  const totalTextLength = messages
    .filter((message) => message.messageType === 'message')
    .reduce((count, message) => {
      return (
        count +
        message.content.reduce((messageCount, block) => {
          return messageCount + (block.type === 'text' ? block.text.trim().length : 0)
        }, 0)
      )
    }, 0)

  return totalTextLength >= 200
}
