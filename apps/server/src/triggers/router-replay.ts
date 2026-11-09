import type { RouterLedgerStore } from '@zero-os/observe'
import type { Message, ToolDefinition } from '@zero-os/shared'
import { type AgentDependencies, TriggerAgentError, runTriggerModel } from './event-agent'
import { createRouterTraceSink } from './router-trace'

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const canonical = (value: unknown): string =>
  JSON.stringify(
    object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, JSON.parse(canonical(value[key]))]),
        )
      : Array.isArray(value)
        ? value.map((item) => JSON.parse(canonical(item)))
        : value,
  )

/** Replay uses recorded returns only. No application capability executor is passed to this loop. */
export function createRouterReplay(deps: AgentDependencies, store: RouterLedgerStore) {
  return async (id: string, signal?: AbortSignal, promptOverride?: string) => {
    if (promptOverride !== undefined && !promptOverride.trim())
      throw new TriggerAgentError('请输入要比较的调试内容。')
    const run = store.getRun(id)
    if (!run || run.status === 'running') throw new TriggerAgentError('只能重放已经结束的轨迹。')
    const entries = []
    let after = 0
    for (;;) {
      const page = store.entries(id, after, 200)
      entries.push(...page)
      if (page.length < 200) break
      after = page[page.length - 1].ordinal
    }
    const input = entries.find((entry) => entry.kind === 'input')?.data
    if (object(input) && input.transport === 'registered-executor')
      throw new TriggerAgentError('这条执行器轨迹记录宿主派工和返回结果，支持查看和导出。')
    if (object(input) && input.transport === 'codex-app-server')
      throw new TriggerAgentError(
        'Codex 轨迹记录的是宿主派工请求和公开执行结果，当前支持查看和导出。',
      )
    if (
      !object(input) ||
      typeof input.system !== 'string' ||
      typeof input.prompt !== 'string' ||
      !Array.isArray(input.history) ||
      !Array.isArray(input.tools)
    )
      throw new TriggerAgentError('这条轨迹缺少可重放的输入。')
    const tools = input.tools as ToolDefinition[]
    const recorded = entries.filter((entry) => entry.kind === 'tool_result')
    const consumed = new Set<number>()
    const replaySession = `replay-${id}`
    const sink = createRouterTraceSink(store, (text) => deps.secretFilter.filter(text), id)
    let replayId = ''
    const output = await runTriggerModel(
      {
        getDefaultModel: () => deps.modelRouter.getDefaultModel(),
        getCurrentModel: () => deps.modelRouter.getCurrentModel(),
        trace: {
          ...sink,
          begin(session, label, data) {
            replayId = sink.begin(session, label, data)
            return replayId
          },
        },
      },
      {
        sessionId: replaySession,
        label:
          promptOverride === undefined ? 'Router 隔离重放' : 'Router 隔离重放（已修改调试输入）',
        signal,
        system: `${input.system}\n本轮是隔离重放。所有工具只能返回此前记录的数据，不会读取实时资源或产生任何外部写入。`,
        prompt: promptOverride ?? input.prompt,
        history: input.history as Message[],
        toolset: {
          definitions: tools,
          async execute(name, args) {
            const index = recorded.findIndex(
              (entry, i) =>
                !consumed.has(i) &&
                object(entry.data) &&
                entry.data.name === name &&
                canonical(entry.data.input) === canonical(args),
            )
            const saved = recorded[index]?.data
            sink.append(replayId, 'replay_tool', {
              name,
              sourceRunId: id,
              sourceEntryOrdinal: recorded[index]?.ordinal ?? null,
              mode: index >= 0 ? 'recorded-result' : 'no-match',
            })
            if (
              index < 0 ||
              !object(saved) ||
              !object(saved.result) ||
              typeof saved.result.output !== 'string'
            )
              throw new TriggerAgentError('隔离重放没有匹配的工具回执；不会调用真实工具。')
            consumed.add(index)
            if (saved.result.success !== true) throw new TriggerAgentError(saved.result.output)
            return saved.result.output
          },
        },
      },
    )
    const completed = store.getRun(replayId)
    if (!completed) throw new TriggerAgentError('无法读取本次重放的轨迹。')
    return {
      text: output,
      run: completed,
      mode: 'recorded-tools-only' as const,
    }
  }
}
