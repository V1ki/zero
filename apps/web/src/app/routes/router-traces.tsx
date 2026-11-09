import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { RouterTraceEntry, RouterTraceRun } from '@zero-os/shared'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, apiPost } from '../lib/api'
import { channels, deliveryNames } from '../lib/router-delivery-labels'
import { workspaceReturnLink } from '../lib/router-trace-navigation'
import { toolLabels } from '../lib/router-tool-labels'
import './router-traces.css'

const base = '/api/listeners/router-traces'
const states: Record<RouterTraceRun['status'], string> = {
  running: '进行中',
  completed: '本轮已结束',
  failed: '本轮失败',
  interrupted: '运行中断',
}
const kinds: Record<RouterTraceEntry['kind'], string> = {
  input: '本轮输入',
  model_request: '发送给模型的完整请求',
  model_response: '模型可见输出',
  worker_request: '发送给 Codex 的请求',
  worker_event: 'Codex 执行记录',
  replay_tool: '重放工具依据',
  tool_start: '开始调用工具',
  tool_result: '工具返回',
  result: '本轮答复',
  error: '失败原因',
}
type TracePage = { run: RouterTraceRun; entries: RouterTraceEntry[]; nextAfter: number | null }

function RecordedInput({ input }: { input: unknown }) {
  if (
    !input ||
    typeof input !== 'object' ||
    !('prompt' in input) ||
    typeof input.prompt !== 'string'
  )
    return null
  let recorded
  try {
    recorded = JSON.parse(input.prompt)
  } catch {
    return null
  }
  if (typeof recorded?.question !== 'string' || !recorded.signal) return null
  const { kind, payload } = recorded.signal
  const labels = {
    user: '收到消息',
    event: '收到事件',
    worker_result: 'Worker 返回结果',
    timer: '到期续办',
    ui_action: '用户操作',
  } as const
  const label = labels[kind as keyof typeof labels]
  if (!label) return null
  return (
    <details>
      <summary>{label}</summary>
      <p className="rt-question">{recorded.question}</p>
      {kind === 'worker_result' && Number.isInteger(payload?.jobId) && (
        <a href={`/router/traces?sessionId=router-job-${payload.jobId}`}>
          查看 Worker #{payload.jobId} 的运行记录
        </a>
      )}
      {kind === 'event' && Number.isInteger(payload?.inboxId) && (
        <a href={`/router?event=${payload.inboxId}`}>打开事件 #{payload.inboxId}</a>
      )}
    </details>
  )
}

function DeliveryAtCall({ entry }: { entry: RouterTraceEntry }) {
  if (entry.kind !== 'tool_result') return null
  const data = entry.data as { name?: string; result?: { success?: boolean; output?: string } }
  if (!['publish_update', 'retry_delivery'].includes(data.name ?? '') || !data.result?.output)
    return null
  if (!data.result.success) return <p>投递调用失败：{data.result.output}</p>
  let receipt
  try {
    receipt = JSON.parse(data.result.output)
  } catch {
    return null
  }
  if (!Array.isArray(receipt?.deliveries)) return null
  return (
    <div>
      <p>本次调用返回的投递状态</p>
      <ul>
        {receipt.deliveries.map(
          (d: {
            channel: keyof typeof channels
            status: keyof typeof deliveryNames
            reason?: string
            receipt?: string
          }) => (
            <li key={d.channel}>
              {channels[d.channel]}：{deliveryNames[d.status]}
              {d.reason && ` · ${d.reason}`}
              {d.receipt && <small> · 回执 {d.receipt}</small>}
            </li>
          ),
        )}
      </ul>
    </div>
  )
}

function entryTitle(entry: RouterTraceEntry) {
  if (entry.kind === 'tool_result' || entry.kind === 'tool_start') {
    const data = entry.data as { name?: string; result?: { success?: boolean } }
    if (data.name)
      return `${kinds[entry.kind]} · ${toolLabels[data.name] ?? data.name}${data.result?.success === false ? '（失败）' : ''}`
  }
  if (entry.kind === 'replay_tool') {
    const data = entry.data as { sourceEntryOrdinal: number | null; name: string }
    return data.sourceEntryOrdinal === null
      ? `${data.name} · 未匹配历史回执`
      : `${data.name} · 使用原记录 #${data.sourceEntryOrdinal}`
  }
  if (entry.kind !== 'worker_event') return kinds[entry.kind]
  const event = entry.data as { method?: string; data?: { type?: string; exitCode?: number } }
  if (event?.method === 'item/completed') {
    switch (event.data?.type) {
      case 'commandExecution':
        return typeof event.data.exitCode === 'number'
          ? `命令结果 · 退出码 ${event.data.exitCode}`
          : '命令结果'
      case 'fileChange':
        return '文件变更'
      case 'agentMessage':
        return 'Codex 答复'
      case 'mcpToolCall':
      case 'dynamicToolCall':
        return '工具调用结果'
      case 'webSearch':
        return '网页检索结果'
    }
  }
  switch (event?.method) {
    case 'thread/ready':
      return '线程已就绪'
    case 'turn/started':
      return '开始执行'
    case 'turn/completed':
      return '本轮执行结束'
    case 'thread/tokenUsage/updated':
      return '本轮用量'
    case 'item/commandExecution/outputDelta':
      return '命令输出'
    default:
      return kinds[entry.kind]
  }
}

function ReplayInputComparison({ sourceId, current }: { sourceId: string; current: unknown }) {
  const [open, setOpen] = useState(false)
  const source = useQuery({
    queryKey: ['router-replay-source', sourceId],
    queryFn: ({ signal }) =>
      apiFetch<TracePage>(`${base}/${encodeURIComponent(sourceId)}`, { signal }),
    enabled: open,
  })
  const prompt = (data: unknown) =>
    data && typeof data === 'object' && 'prompt' in data && typeof data.prompt === 'string'
      ? data.prompt
      : undefined
  const before = prompt(source.data?.entries.find((e) => e.kind === 'input')?.data)
  const after = prompt(current)
  return (
    <>
      <a href={`/router/traces?selected=${encodeURIComponent(sourceId)}`}>查看原运行</a>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>对比原运行与重放的输入</summary>
        {open &&
          (source.isPending ? (
            <output>正在读取原运行…</output>
          ) : source.isError ? (
            <p role="alert">{source.error.message}</p>
          ) : before === undefined || after === undefined ? (
            <p>这条历史记录缺少可对比的输入。</p>
          ) : before === after ? (
            <p>两次提交给模型的任务正文相同。</p>
          ) : (
            <div className="rt-comparison">
              <section>
                <h3>原始输入</h3>
                <pre>{before}</pre>
              </section>
              <section>
                <h3>重放输入</h3>
                <pre>{after}</pre>
              </section>
            </div>
          ))}
      </details>
    </>
  )
}

function openTraceEntry(ordinal: number) {
  const detail = document.getElementById(`trace-entry-${ordinal}`)
  if (!(detail instanceof HTMLDetailsElement)) return
  detail.open = true
  detail.scrollIntoView({ block: 'nearest' })
  detail.querySelector('summary')?.focus()
}

function ReceiptReferences({
  entry,
  entries,
}: { entry: RouterTraceEntry; entries: RouterTraceEntry[] }) {
  if (entry.kind !== 'model_request') return null
  const projection = (
    entry.data as { projection?: { originals: string[]; historyMessages?: string[] } }
  ).projection
  if (!projection) return null
  return (
    <div className="rt-hint">
      <p>为适应模型窗口，本次输入折叠了部分资料。可从原记录查看完整内容。</p>
      {!!projection.historyMessages?.length && (
        <p>
          折叠的历史答复：
          {projection.historyMessages.map((id) => id.replace('router-assistant-', '#')).join('、')}
        </p>
      )}
      {entries
        .filter(
          (item) =>
            (item.kind === 'tool_result' &&
              projection.originals.includes((item.data as { id: string }).id)) ||
            (item.kind === 'input' && !!projection.historyMessages?.length),
        )
        .map((item) => (
          <button key={item.ordinal} type="button" onClick={() => openTraceEntry(item.ordinal)}>
            {item.kind === 'input' ? '查看折叠前的对话' : '查看原回执'} #{item.ordinal}
          </button>
        ))}
    </div>
  )
}

function TraceDetail({ id }: { id: string }) {
  const [promptOverride, setPromptOverride] = useState<string | undefined>()
  const [compare, setCompare] = useState(0)
  const detail = useInfiniteQuery({
    queryKey: ['router-trace', id],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiFetch<TracePage>(`${base}/${encodeURIComponent(id)}?after=${pageParam}`),
    getNextPageParam: (page) => page.nextAfter ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages[0].run.status === 'running' ? 3000 : false,
  })
  const replay = useMutation({
    mutationFn: () =>
      apiPost<{ text: string; run: RouterTraceRun }>(
        `${base}/${encodeURIComponent(id)}/replay`,
        promptOverride === undefined ? {} : { prompt: promptOverride },
      ),
  })
  const run = detail.data?.pages[0].run
  const entries = detail.data?.pages.flatMap((page) => page.entries) ?? []
  const [target] = useState(() => {
    const search = new URLSearchParams(window.location.search)
    const ordinal = Number(search.get('entry'))
    return search.get('selected') === id && Number.isSafeInteger(ordinal) && ordinal > 0
      ? ordinal
      : null
  })
  const focused = useRef(false)
  const targetLoaded = target !== null && entries.some((entry) => entry.ordinal === target)
  const targetBeyondPage =
    target !== null && (entries.at(-1)?.ordinal ?? 0) < target && detail.hasNextPage
  const { fetchNextPage, isFetching, isError } = detail
  useEffect(() => {
    if (!target || focused.current || isError) return
    if (targetLoaded) {
      openTraceEntry(target)
      focused.current = true
    } else if (targetBeyondPage && !isFetching) {
      void fetchNextPage()
    }
  }, [target, targetLoaded, targetBeyondPage, isFetching, isError, fetchNextPage])
  const requests = entries.filter((entry) => entry.kind === 'model_request')
  const input = entries.find((e) => e.kind === 'input')?.data
  const isCodex =
    !!input &&
    typeof input === 'object' &&
    'transport' in input &&
    input.transport === 'codex-app-server'
  const isAdapter =
    !!input &&
    typeof input === 'object' &&
    'transport' in input &&
    input.transport === 'registered-executor'
  if (detail.isPending) return <output>正在读取轨迹…</output>
  if (detail.isError) return <p role="alert">轨迹读取失败：{detail.error.message}</p>
  return (
    <section className="rt-detail" aria-label="运行详情">
      <h2>{run?.label}</h2>
      <p>
        {run && states[run.status]} · {run?.startedAt}
      </p>
      <p>
        会话：<code>{run?.sessionId}</code>
        {run?.relatedMatters && run.relatedMatters.length > 1 ? (
          <>
            {' '}
            · 本轮涉及的事项：
            {run.relatedMatters.map((m) => (
              <a key={m.id} href={`/router?view=tasks&matterId=${encodeURIComponent(m.id)}`}>
                {m.title}{' '}
              </a>
            ))}
          </>
        ) : (
          run?.matterId && (
            <>
              {' '}
              ·{' '}
              <a href={`/router?view=tasks&matterId=${encodeURIComponent(run.matterId)}`}>
                返回这件跟进事项
              </a>
            </>
          )
        )}
      </p>
      <p className="rt-hint">
        {isCodex
          ? '这里可以查看 ZeRo 发给 Codex 的任务、线程编号和公开执行结果。模型内部请求由 Codex 管理。'
          : isAdapter
            ? '这里记录了交给执行器的任务、此前进展及本次实际返回的结果。'
            : '这里可以查看每轮发送给模型的内容、公开答复和工具结果。'}
      </p>
      <RecordedInput input={input} />
      {run?.replayOf && <ReplayInputComparison sourceId={run.replayOf} current={input} />}
      {requests.length > 1 && (
        <details>
          <summary>对比相邻模型调用的上下文</summary>
          <label>
            选择前一轮调用{' '}
            <select value={compare} onChange={(event) => setCompare(Number(event.target.value))}>
              {requests.slice(0, -1).map((entry, i) => (
                <option key={entry.ordinal} value={i}>
                  调用 {i + 1} 与 {i + 2}
                </option>
              ))}
            </select>
          </label>
          <p className="rt-hint">
            以下是实际发送的输入；可核对历史、工具回执及压缩或修订造成的变化。尚未加载的记录不参与对比。
          </p>
          <div className="rt-comparison">
            <section>
              <h3>前一轮输入</h3>
              <pre>{JSON.stringify(requests[compare]?.data, null, 2)}</pre>
            </section>
            <section>
              <h3>后一轮输入</h3>
              <pre>{JSON.stringify(requests[compare + 1]?.data, null, 2)}</pre>
            </section>
          </div>
        </details>
      )}
      {target && !targetLoaded && (
        <p role="status">
          {targetBeyondPage ? '正在查找这条回执…' : '这次运行中没有找到链接指定的回执。'}
        </p>
      )}
      <ol className="rt-entries">
        {entries.map((entry) => (
          <li key={entry.ordinal}>
            <details
              id={`trace-entry-${entry.ordinal}`}
              open={entry.kind === 'error' || entry.kind === 'result'}
            >
              <summary>
                {entryTitle(entry)}{' '}
                <time dateTime={entry.createdAt}>
                  {new Date(entry.createdAt).toLocaleTimeString('zh-CN')}
                </time>
              </summary>
              <ReceiptReferences entry={entry} entries={entries} />
              <DeliveryAtCall entry={entry} />
              <pre>{JSON.stringify(entry.data, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ol>
      {detail.hasNextPage && (
        <button
          type="button"
          disabled={detail.isFetchingNextPage}
          onClick={() => detail.fetchNextPage()}
        >
          加载后续记录
        </button>
      )}
      {!isCodex && !isAdapter && (
        <>
          <details>
            <summary>修正调试输入后重放</summary>
            <p className="rt-hint">
              只修改这次隔离重放的输入，不修改真实事项。模型版本可能变化，答复不保证完全相同。
            </p>
            <button
              type="button"
              onClick={() => {
                const input = entries.find((entry) => entry.kind === 'input')?.data
                if (
                  input &&
                  typeof input === 'object' &&
                  'prompt' in input &&
                  typeof input.prompt === 'string'
                )
                  setPromptOverride(input.prompt)
              }}
            >
              载入原始输入
            </button>
            <label>
              调试输入
              <textarea
                value={promptOverride ?? ''}
                onChange={(event) => setPromptOverride(event.target.value || undefined)}
              />
            </label>
          </details>
          <button
            type="button"
            disabled={replay.isPending || run?.status === 'running'}
            onClick={() => replay.mutate()}
          >
            {replay.isPending ? '正在隔离重放…' : '用已记录回执重放'}
          </button>
          <p className="rt-hint">
            重放会再次调用模型，只使用保存的工具回执，不执行真实工具或发送通知。
          </p>
          {replay.isError && <p role="alert">重放失败：{replay.error.message}</p>}
          {replay.data && (
            <details open>
              <summary>原答复与重放结果</summary>
              <div className="rt-comparison">
                <section>
                  <h3>原答复</h3>
                  <pre>
                    {JSON.stringify(
                      entries.find((entry) => entry.kind === 'result')?.data ??
                        '请加载后续记录以读取原答复。',
                      null,
                      2,
                    )}
                  </pre>
                </section>
                <section>
                  <h3>重放答复</h3>
                  <pre>{replay.data.text}</pre>
                  <a href={`/router/traces?selected=${encodeURIComponent(replay.data.run.id)}`}>
                    查看本次重放轨迹
                  </a>
                  <p>只复用原工具回执，新的工具或不同参数会被拒绝；原始轨迹保持不变。</p>
                </section>
              </div>
            </details>
          )}
        </>
      )}
      <a href={`${base}/${encodeURIComponent(id)}/export`} download>
        导出完整轨迹
      </a>
    </section>
  )
}

export function RouterTracesPage() {
  const [query, setQuery] = useState('')
  const [session, setSession] = useState(
    () => new URLSearchParams(window.location.search).get('sessionId') ?? '',
  )
  const [matter, setMatter] = useState(
    () => new URLSearchParams(window.location.search).get('matterId') ?? '',
  )
  const [extra, setExtra] = useState({
    runId: '',
    toolCallId: '',
    status: '',
    platform: '',
    eventId: '',
    workerId: '',
    startedAfter: '',
    startedBefore: '',
  })
  const [filter, setFilter] = useState({ query, session, matter, ...extra })
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('selected'),
  )
  const list = useInfiniteQuery({
    queryKey: ['router-traces', filter],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({
        q: filter.query,
        sessionId: filter.session,
        matterId: filter.matter,
      })
      for (const key of [
        'runId',
        'toolCallId',
        'status',
        'platform',
        'eventId',
        'workerId',
        'startedAfter',
        'startedBefore',
      ] as const) {
        const value = filter[key]
        if (value)
          search.set(key, key.startsWith('started') ? new Date(value).toISOString() : value)
      }
      if (pageParam) search.set('before', String(pageParam))
      return apiFetch<{ items: RouterTraceRun[]; expiredSources?: Array<'event' | 'worker'> }>(
        `${base}?${search}`,
      )
    },
    getNextPageParam: (page) => (page.items.length === 30 ? page.items.at(-1)?.ordinal : undefined),
    refetchInterval: 5000,
  })
  const runs = list.data?.pages.flatMap((page) => page.items) ?? []
  const back = workspaceReturnLink()
  return (
    <div className="rt-page">
      <header>
        <div>
          <h1>Router 处理轨迹</h1>
          {back && <a href={back}>返回原阅读位置</a>}
          <p>检查上下文、工具调用和结果，定位每一轮实际发生了什么。</p>
        </div>
        <Link to="/router">返回 Router</Link>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setFilter({ query, session, matter, ...extra })
          setSelected(null)
        }}
      >
        <label>
          搜索内容
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="事项、仓库、工具或错误"
          />
        </label>
        <label>
          会话标识
          <input
            value={session}
            onChange={(event) => setSession(event.target.value)}
            placeholder="可选，精确匹配"
          />
        </label>
        <label>
          事项标识
          <input
            value={matter}
            onChange={(event) => setMatter(event.target.value)}
            placeholder="可选，精确匹配"
          />
        </label>
        <details className="rt-filters">
          <summary>更多筛选</summary>
          <div className="rt-filter-fields">
            {(
              [
                ['runId', '运行标识'],
                ['toolCallId', '工具调用标识'],
                ['eventId', '事件编号'],
                ['workerId', 'Worker 编号'],
                ['startedAfter', '开始时间'],
                ['startedBefore', '结束时间'],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  value={extra[key]}
                  type={
                    key.startsWith('started')
                      ? 'datetime-local'
                      : key === 'workerId' || key === 'eventId'
                        ? 'number'
                        : 'text'
                  }
                  min="1"
                  onChange={(event) => setExtra({ ...extra, [key]: event.target.value })}
                />
              </label>
            ))}
            <label>
              状态
              <select
                value={extra.status}
                onChange={(event) => setExtra({ ...extra, status: event.target.value })}
              >
                <option value="">全部状态</option>
                {Object.entries(states).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              输入平台
              <select
                value={extra.platform}
                onChange={(event) => setExtra({ ...extra, platform: event.target.value })}
              >
                <option value="">全部平台</option>
                {[
                  ['web', '网页'],
                  ['weixin', '微信'],
                  ['dingtalk', '钉钉'],
                  ['feishu', '飞书'],
                  ['github', 'GitHub'],
                  ['wxarc', '微信归档'],
                  ['worker_result', 'Worker 返回'],
                  ['timer', '定时唤醒'],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
        <button type="submit">查询</button>
      </form>
      {list.isError && <p role="alert">查询失败：{list.error.message}</p>}
      <div className="rt-columns">
        <nav aria-label="运行列表">
          {list.isPending ? (
            <output>正在查询…</output>
          ) : (
            !list.isError && !runs.length && <p>没有找到符合当前筛选条件的轨迹。</p>
          )}
          {list.data?.pages[0].expiredSources?.map((source) => (
            <p key={source}>
              {source === 'event' ? '原事件' : '原 Worker 任务'}
              的正文已过保留期。这里仍可查询已保存的运行轨迹。
            </p>
          ))}
          {runs.map((run) => (
            <button
              type="button"
              key={run.id}
              aria-pressed={selected === run.id}
              onClick={() => setSelected(run.id)}
            >
              <strong>{run.label}</strong>
              <span>{states[run.status]}</span>
              <time dateTime={run.startedAt}>
                {new Date(run.startedAt).toLocaleString('zh-CN')}
              </time>
              <small>{run.sessionId}</small>
            </button>
          ))}
          {list.hasNextPage && (
            <button
              type="button"
              disabled={list.isFetchingNextPage}
              onClick={() => list.fetchNextPage()}
            >
              查看更早记录
            </button>
          )}
        </nav>
        {selected ? (
          <TraceDetail key={selected} id={selected} />
        ) : (
          <p className="rt-hint">选择一条运行，查看模型输入和处理过程。</p>
        )}
      </div>
    </div>
  )
}
