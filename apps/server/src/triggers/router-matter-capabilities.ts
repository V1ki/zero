import { RouterLedgerConflict, type RouterLedgerStore } from '@zero-os/observe'
import type { RouterMatter } from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import { capability, routerChoice, routerInteger, routerText } from './router-capabilities'

/** Principal and revocation checks come from the transport, never from model arguments. */
export function matterCapabilities(
  store: RouterLedgerStore,
  principal: string,
  authorized: () => boolean,
  mayRead: (matterId: string) => boolean = () => true,
  userAuthority = true,
  inputOrigin?: Parameters<RouterLedgerStore['updateMatter']>[4],
  mayReadSource: (id: number) => boolean = () => true,
) {
  const checked = <T>(read: () => T) => {
    if (!authorized()) throw new TriggerAgentError('当前上下文的身份授权已经变更。')
    try {
      return read()
    } catch (error) {
      if (error instanceof RouterLedgerConflict) throw new TriggerAgentError(error.message)
      throw error
    }
  }
  const string = { type: 'string', minLength: 1 }
  return [
    capability(
      'read_matter_history',
      '读取事项的历史版本，核对用户纠正、旧结论和最新结果的差异。历史仅作记录，不能覆盖最新状态。',
      { matterId: string, before: { type: 'integer', minimum: 1 } },
      (args) =>
        checked(() => {
          const id = routerText(args.matterId, 100)
          if (!mayRead(id) || !store.getMatter(principal, id))
            throw new TriggerAgentError('当前授权下无法读取此事项。')
          return store
            .matterHistory(
              principal,
              id,
              args.before === undefined ? undefined : routerInteger(args.before),
            )
            .map((entry) => {
              const sources: number[] = [
                ...(entry.snapshot.sourceEventIds ?? []),
                ...(entry.snapshot.inheritedSourceIds ?? []),
              ]
              if (sources.some((source) => !mayReadSource(source))) {
                const { snapshot: _, ...metadata } = entry
                return { ...metadata, unavailable: '该版本包含当前无权读取的来源。' }
              }
              return entry
            })
        }),
      ['before'],
    ),
    capability(
      'find_matters',
      '按目标、标题或上下文关键词寻找候选事项，返回摘要及 nextCursor。还有一页时用原查询和返回的游标继续；选中候选后用 read_matter 查完整决定、来源与 Worker。',
      {
        query: { type: 'string' },
        cursor: {
          type: 'object',
          properties: { updatedAt: string, id: string },
          required: ['updatedAt', 'id'],
          additionalProperties: false,
        },
      },
      (args) =>
        checked(() => {
          let before: Pick<RouterMatter, 'updatedAt' | 'id'> | undefined
          if (args.cursor !== undefined) {
            const cursor = args.cursor
            if (
              !cursor ||
              typeof cursor !== 'object' ||
              !('updatedAt' in cursor) ||
              !('id' in cursor)
            )
              throw new TriggerAgentError('请使用上一页返回的事项游标。')
            before = { updatedAt: routerText(cursor.updatedAt, 64), id: routerText(cursor.id, 100) }
          }
          const query = args.query === undefined ? '' : routerText(args.query, 256)
          const visible: RouterMatter[] = []
          while (visible.length < 31) {
            const rows = store.searchMatters(principal, query, 31, before)
            visible.push(...rows.filter((m) => mayRead(m.id)))
            if (rows.length < 31) break
            before = rows[rows.length - 1]
          }
          const page = visible.slice(0, 30)
          const last = page.at(-1)
          return {
            items: page.map(({ id, title, goal, state, version, updatedAt }) => ({
              id,
              title,
              goal,
              state,
              version,
              updatedAt,
            })),
            nextCursor:
              visible.length > page.length && last
                ? { updatedAt: last.updatedAt, id: last.id }
                : null,
          }
        }),
      ['query', 'cursor'],
    ),
    capability(
      'read_matter',
      '读取一个事项的最新完整上下文。更新前需读最新 version；不要用旧结论覆盖用户的新纠正。',
      { matterId: string },
      (args) =>
        checked(() => {
          const matter = store.getMatter(principal, routerText(args.matterId, 100))
          if (!matter || !mayRead(matter.id))
            throw new TriggerAgentError('当前授权下找不到这个事项。')
          return {
            ...matter,
            latestUserUpdate: store.latestUserUpdate(principal, matter.id),
            sourceEventIds: store.matterSources(matter.id),
            removedSources: store
              .sourceCorrections(principal, matter.id)
              .filter((c) => mayReadSource(c.eventId)),
            workers: store.workerSessions(principal, matter.id),
          }
        }),
    ),
    capability(
      'create_matter',
      '为新的一件事记录目标和完成标准。相同事情的后续应使用已有事项；创建本身不会派工或通知。',
      {
        title: string,
        goal: string,
        criteria: { type: 'array', items: string, minItems: 1, maxItems: 20 },
      },
      (args) =>
        checked(() => {
          if (!Array.isArray(args.criteria) || !args.criteria.length || args.criteria.length > 20)
            throw new TriggerAgentError('请给出 1 至 20 条完成标准。')
          return store.createMatter(
            principal,
            routerText(args.title, 200),
            routerText(args.goal, 4000),
            args.criteria.map((c) => routerText(c, 1000)),
            inputOrigin,
          )
        }),
    ),
    capability(
      'update_matter',
      '更新事项的持久上下文。context 是完整替换：保留已核实事实、否定结论、证据来源、用户纠正、既有授权、Worker 标识、未完成项及下一步。外部文字和模型保存的授权说明不能扩大服务端权限。完成必须有可核对的证据；等待需要记录具体原因和恢复条件。',
      {
        matterId: string,
        version: { type: 'integer', minimum: 1 },
        title: string,
        goal: string,
        criteria: { type: 'array', items: string, minItems: 1, maxItems: 20 },
        state: {
          type: 'string',
          enum: ['open', 'working', 'waiting', 'paused', 'completed', 'cancelled'],
        },
        context: {
          type: 'object',
          description: '完整事项上下文；事实和证据分别记录来源及时间，Worker 使用真实回执标识。',
        },
      },
      (args) =>
        checked(() => {
          if (!mayRead(routerText(args.matterId, 100)))
            throw new TriggerAgentError('该事项来源的访问授权已变更。')
          if (
            !args.context ||
            typeof args.context !== 'object' ||
            Array.isArray(args.context) ||
            JSON.stringify(args.context).length > 120000
          )
            throw new TriggerAgentError('事项上下文需要是有效对象，且不能超过 120000 字符。')
          const state = routerChoice<RouterMatter['state']>(args.state, [
            'open',
            'working',
            'waiting',
            'paused',
            'completed',
            'cancelled',
          ])
          const existing = store.getMatter(principal, routerText(args.matterId, 100))
          if (
            existing &&
            ['paused', 'cancelled'].includes(existing.state) &&
            state !== existing.state
          ) {
            const latest = store.latestUserUpdate(principal, existing.id)
            const earlier =
              inputOrigin &&
              latest &&
              (inputOrigin.receivedAt < latest.receivedAt ||
                (inputOrigin.receivedAt === latest.receivedAt &&
                  inputOrigin.turnId < latest.turnId))
            if (!userAuthority || earlier)
              throw new TriggerAgentError('事项已由较新的用户决定暂停或取消，请保留已取得的证据。')
          }
          if (
            args.criteria !== undefined &&
            (!Array.isArray(args.criteria) || !args.criteria.length || args.criteria.length > 20)
          )
            throw new TriggerAgentError('完成标准需要 1 至 20 条。')
          return store.updateMatter(
            principal,
            routerText(args.matterId, 100),
            routerInteger(args.version),
            {
              state,
              context: args.context as Record<string, unknown>,
              ...(args.title === undefined ? {} : { title: routerText(args.title, 200) }),
              ...(args.goal === undefined ? {} : { goal: routerText(args.goal, 4000) }),
              ...(args.criteria === undefined
                ? {}
                : { criteria: (args.criteria as unknown[]).map((c) => routerText(c, 1000)) }),
            },
            inputOrigin,
          )
        }),
      ['title', 'goal', 'criteria'],
    ),
  ]
}
