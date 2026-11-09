import { createHash } from 'node:crypto'
import type { RouterLedgerStore } from '@zero-os/observe'
import { TriggerAgentError } from './event-agent'
import { capability, routerText } from './router-capabilities'

/** A saved wake-up re-enters the same Agent. It never hardcodes the next business action. */
export function followupCapabilities(
  store: RouterLedgerStore,
  principal: string,
  scope: string,
  turnId: number,
  authorized: () => boolean,
  mayRead: (matterId: string) => boolean = () => true,
) {
  const checked = <T>(run: () => T) => {
    if (!authorized()) throw new TriggerAgentError('身份授权已变更。')
    return run()
  }
  const text = { type: 'string', minLength: 1 }
  return [
    capability(
      'schedule_followup',
      '保存一次到期唤醒；即使服务重启仍会触发同一个 Router 主循环，由它读取最新事项再判断。不是自动发送通知，也不会预先写死业务动作。等待外部结果或约定时间时，保存具体原因与时间。',
      {
        matterId: text,
        dueAt: { type: 'string', description: '带时区的 ISO 8601 时间' },
        reason: text,
      },
      (args) =>
        checked(() => {
          const matterId = routerText(args.matterId, 100)
          if (!mayRead(matterId)) throw new TriggerAgentError('此事项的跟进记录不可访问。')
          const dueAt = routerText(args.dueAt, 80)
          const reason = routerText(args.reason, 2000)
          return store.scheduleTimer({
            principal,
            scope,
            matterId,
            dueAt,
            reason,
            requestKey: createHash('sha256')
              .update(JSON.stringify([principal, turnId, matterId, dueAt, reason]))
              .digest('hex'),
          })
        }),
    ),
    capability(
      'list_followups',
      '查看事项已有的定时跟进，避免重复安排。',
      { matterId: text },
      (args) =>
        checked(() => {
          const matterId = routerText(args.matterId, 100)
          if (!mayRead(matterId)) throw new TriggerAgentError('此事项的跟进记录不可访问。')
          return store.listTimers(principal, matterId)
        }),
    ),
    capability(
      'cancel_followup',
      '取消当前身份下尚未触发的定时跟进。已触发的记录保留，不会撤回已经发生的操作。',
      {
        timerId: text,
        reason: { ...text, description: '哪条新信息使这次提醒可以取消或与另一提醒合并。' },
      },
      (args) =>
        checked(() => {
          const id = routerText(args.timerId, 100)
          const timer = store.getTimer(principal, id)
          if (!timer || !mayRead(timer.matterId))
            throw new TriggerAgentError('此事项的跟进记录不可访问。')
          return store.cancelTimer(principal, id, { turnId, reason: routerText(args.reason, 2000) })
        }),
    ),
  ]
}
