import type { RouterSignal } from './router-ledger'
import type { RouterJobReceipt } from './types/trigger-conversation'

/** Processing of an input is separate from notification delivery and matter completion. */
export interface RouterEventActivity {
  state: RouterSignal['state']
  kind: RouterSignal['kind']
  error: string | null
  worker?: Pick<RouterJobReceipt, 'id' | 'attempt' | 'status'>
}

export function routerEventActivityLabel(activity: RouterEventActivity): string {
  if (activity.state === 'pending') return '等待 Router 处理'
  if (activity.state === 'running')
    return activity.kind === 'worker_result' ? 'Router 正在处理 Worker 结果' : 'Router 正在处理'
  if (activity.state === 'failed') return 'Router 处理失败'
  if (activity.state === 'interrupted') return 'Router 处理已中断'
  if (activity.state === 'cancelled') return 'Router 处理已取消'
  const worker = activity.worker
  if (worker?.status === 'queued') return `Worker #${worker.id} 等待执行`
  if (worker?.status === 'running') return `Worker #${worker.id} 正在处理`
  if (worker?.status === 'failed') return `Worker #${worker.id} 执行失败`
  if (worker?.status === 'unknown') return `Worker #${worker.id} 结果待核对`
  if (worker?.status === 'completed') return `Worker #${worker.id} 已返回结果`
  return 'Router 已处理'
}
