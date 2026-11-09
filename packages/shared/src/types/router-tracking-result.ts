import type { RouterJobReceipt } from './trigger-conversation'

export type RouterPublicGithubFact = { label: '当前状态' | '评论时间'; value: string }

/** Values that the trusted GitHub reader may copy verbatim to the same public discussion. */
export function isPublicGithubFact(fact: unknown): fact is RouterPublicGithubFact {
  if (
    !fact ||
    typeof fact !== 'object' ||
    !('label' in fact) ||
    !('value' in fact) ||
    typeof fact.value !== 'string'
  )
    return false
  if (fact.label === '当前状态') return ['打开', '已关闭', '已合并'].includes(fact.value)
  if (
    fact.label !== '评论时间' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fact.value)
  )
    return false
  const time = Date.parse(fact.value)
  return Number.isFinite(time) && new Date(time).toISOString() === fact.value
}

export interface RouterEventWork {
  /** Router's decision for this turn. Only scoped tool receipts can authorize or attest actions. */
  followup?: {
    kind: 'new' | 'continue'
    decision: 'act' | 'observe'
    reason: string
  }
  publicFacts?: RouterPublicGithubFact[]
  outcome: 'observed' | 'resolved' | 'needs_input'
  steps: {
    tool:
      | 'inspect_github'
      | 'compare_runs'
      | 'find_related_issues'
      | 'close_issue'
      | 'inspect_archive'
    ok: boolean
  }[]
  sources: { label: string; url: string }[]
}

/** A source event and its Worker receipt, visible to the currently authorized local operator. */
export interface RouterTrackingResult {
  /** Stable across subsequent events handled by the same Worker. Use inboxId to page event history. */
  id: number
  attempt?: number
  traceRunId?: string
  /** Set only when the local operator explicitly asks the Worker to handle this event. */
  workOrigin?: 'manual'
  /** Missing for legacy summary-only attempts and unfinished attempts. */
  work?: RouterEventWork
  previous?: Pick<
    RouterTrackingResult,
    'status' | 'result' | 'work' | 'workOrigin' | 'traceRunId'
  > & {
    attempt: number
  }
  repository: string
  inboxId: number
  title: string
  url?: string
  occurredAt: string
  source?: 'github' | 'wxarc'
  kind: 'issue' | 'pr' | 'issue-comment' | 'pr-comment' | 'workflow-failure' | 'archive-message'
  status: RouterJobReceipt['status']
  needsAttention: boolean
  attentionQuestion?: string
  result: string | null
}
