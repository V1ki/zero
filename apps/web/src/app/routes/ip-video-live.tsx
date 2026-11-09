import {
  ArrowClockwise,
  Books,
  Cube,
  DownloadSimple,
  FileText,
  FilmReel,
  Gear,
  House,
  MagnifyingGlass,
  MonitorPlay,
  Rows,
  Stack,
  UploadSimple,
  User,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AssetKind, Evidence, ProjectSummary, ProjectView } from '../../ip-video/types'
import {
  assetExcerpt,
  catalogAssets,
  coveragePercent,
  evidenceRange,
  filterAssets,
  kindLabels,
  statusLabels as labels,
  selectedCanonicalAsset,
} from '../data/ip-video-view'

type View = 'overview' | 'library' | 'assets' | 'requests' | 'settings'
const API = '/api/ip-video'
const PAGE_SIZE = 12
const kinds = ['all', 'character', 'location', 'prop'] as const

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`提取后端未返回 JSON（HTTP ${response.status}），请检查独立后端与代理`)
  }
  if (!response.ok)
    throw new Error(
      typeof body === 'object' && body && 'error' in body
        ? String(body.error)
        : `HTTP ${response.status}`,
    )
  return body as T
}

function AssetSymbol({ kind, size = 43 }: { kind: AssetKind; size?: number }) {
  const Icon = kind === 'character' ? User : kind === 'location' ? House : Cube
  return <Icon size={size} weight="duotone" aria-hidden="true" />
}

export function IPVideoLive({ onDemo }: { onDemo: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [project, setProject] = useState<ProjectView | null>(null)
  const [id, setId] = useState('')
  const [view, setView] = useState<View>('overview')
  const [chapterId, setChapterId] = useState('')
  const [chapterQuery, setChapterQuery] = useState('')
  const [source, setSource] = useState<{
    projectId: string
    chapterId: string
    text: string
  } | null>(null)
  const [quote, setQuote] = useState<Evidence | null>(null)
  const [filter, setFilter] = useState<'all' | AssetKind>('all')
  const [query, setQuery] = useState('')
  const [assetId, setAssetId] = useState('')
  const [page, setPage] = useState(0)
  const [listError, setListError] = useState('')
  const [projectError, setProjectError] = useState('')
  const [sourceError, setSourceError] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [streamError, setStreamError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [sourceRefresh, setSourceRefresh] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const readingPane = useRef<HTMLDivElement>(null)
  const quoteMark = useRef<HTMLElement>(null)
  const detail = useRef<HTMLElement>(null)
  const inFlight = useRef(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads the project list.
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true)
    setListError('')
    request<ProjectSummary[]>('/projects', { signal: abort.signal })
      .then((items) => {
        if (abort.signal.aborted) return
        setProjects(items)
        setId((current) =>
          items.some((item) => item.id === current) ? current : (items[0]?.id ?? ''),
        )
      })
      .catch((error: Error) => {
        if (!abort.signal.aborted) setListError(error.message)
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false)
      })
    return () => abort.abort()
  }, [refresh])

  // biome-ignore lint/correctness/useExhaustiveDependencies: switching projects resets project-scoped selections.
  useEffect(() => {
    setProject(null)
    setChapterId('')
    setQuote(null)
    setAssetId('')
    setQuery('')
    setChapterQuery('')
    setPage(0)
    setFilter('all')
    setActionError('')
  }, [id])

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh reconnects SSE and reloads the HTTP snapshot.
  useEffect(() => {
    setConnected(false)
    setStreamError('')
    setProjectError('')
    if (!id) return
    const abort = new AbortController()
    let receivedEvent = false
    const apply = (next: ProjectView) => {
      if (abort.signal.aborted || next.id !== id) return
      setProject(next)
      setChapterId((current) =>
        next.chapters.some((item) => item.id === current) ? current : (next.chapters[0]?.id ?? ''),
      )
      setProjectError('')
    }
    // HTTP snapshot keeps saved results usable even when SSE is unavailable.
    request<ProjectView>(`/projects/${id}`, { signal: abort.signal })
      .then((next) => {
        if (!receivedEvent) apply(next)
      })
      .catch((error: Error) => {
        if (!abort.signal.aborted && !receivedEvent) setProjectError(error.message)
      })
    const events = new EventSource(`${API}/projects/${id}/events`)
    events.onmessage = (event) => {
      if (abort.signal.aborted) return
      try {
        const next = JSON.parse(event.data) as ProjectView
        if (
          next.id !== id ||
          !next.progress ||
          !Array.isArray(next.assets) ||
          !Array.isArray(next.chapters)
        ) {
          throw new Error('进度数据格式无效')
        }
        receivedEvent = true
        apply(next)
        setConnected(true)
        setStreamError('')
      } catch {
        setConnected(false)
        setStreamError('进度数据格式无效；可刷新读取已保存结果')
      }
    }
    events.onerror = () => {
      if (abort.signal.aborted) return
      setConnected(false)
      setStreamError('实时进度断开，正在重连；当前为已读取快照，可刷新结果')
    }
    return () => {
      abort.abort()
      events.close()
    }
  }, [id, refresh])

  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceRefresh retries the same chapter after a read failure.
  useEffect(() => {
    setSource(null)
    setSourceError('')
    if (!id || !chapterId) return
    const abort = new AbortController()
    fetch(`${API}/projects/${id}/chapters/${chapterId}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`章节读取失败：HTTP ${response.status}`)
        const text = await response.text()
        if (!abort.signal.aborted) setSource({ projectId: id, chapterId, text })
      })
      .catch((error: Error) => {
        if (!abort.signal.aborted) setSourceError(error.message)
      })
    return () => abort.abort()
  }, [id, chapterId, sourceRefresh])

  const current = project?.id === id ? project : null
  const chapter = current?.chapters.find((item) => item.id === chapterId)
  const chapterText =
    source?.projectId === id && source.chapterId === chapterId ? source.text : null
  const range = evidenceRange(chapterText ?? '', quote?.chapterId === chapterId ? quote : null)
  useEffect(() => {
    if (view !== 'library' || chapterText === null) return
    if (quote && quoteMark.current) quoteMark.current.scrollIntoView({ block: 'center' })
    else readingPane.current?.scrollTo({ top: 0 })
  }, [chapterText, view, quote])

  const catalog = useMemo(() => (current ? catalogAssets(current) : []), [current])
  const assets = useMemo(() => filterAssets(catalog, filter, query), [catalog, filter, query])
  const pageCount = Math.max(1, Math.ceil(assets.length / PAGE_SIZE))
  const activePage = Math.min(page, pageCount - 1)
  const pageAssets = assets.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE)
  const canonical = current ? selectedCanonicalAsset(current, assetId) : undefined
  const selected =
    pageAssets.find(
      (asset) =>
        asset.id === assetId ||
        asset.id === canonical?.id ||
        catalog.find((a) => a.id === asset.id)?.memberIds?.includes(canonical?.id ?? ''),
    ) ?? pageAssets[0]
  const selectedMembers = catalog
    .find((a) => a.id === selected?.id)
    ?.memberIds?.map((id) => current?.assets.find((a) => a.id === id))
    .filter((a) => a !== undefined)
  const chunks = current?.chunks.filter((item) => item.chapterId === chapterId) ?? []
  const ai = current?.identityResolution?.ai
  const percent = current ? coveragePercent(current) : 0

  function chooseChapter(nextId: string) {
    setQuote(null)
    setChapterId(nextId)
    setView('library')
  }
  function jumpToEvidence(evidence: Evidence) {
    setChapterQuery('')
    setChapterId(evidence.chapterId)
    setQuote(evidence)
    setView('library')
  }

  async function importFile(file?: File) {
    if (!file || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setActionError('')
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MiB')
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await file.arrayBuffer(),
      )
      const result = await request<ProjectView>('/projects', {
        method: 'POST',
        body: JSON.stringify({ title: file.name.replace(/\.(txt|md)$/i, ''), source: text }),
      })
      setProjects((items) => [result, ...items.filter((item) => item.id !== result.id)])
      setId(result.id)
      setRefresh((value) => value + 1)
      setView('library')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      inFlight.current = false
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  async function analyze() {
    if (
      !current ||
      inFlight.current ||
      current.status === 'running' ||
      current.status === 'completed'
    )
      return
    inFlight.current = true
    setBusy(true)
    setActionError('')
    try {
      await request(`/projects/${id}/analyze`, {
        method: 'POST',
        body: JSON.stringify({ retryFailed: true, concurrency: 6 }),
      })
      // The accepted request is not a successful extraction; reload actual persisted state.
      setRefresh((value) => value + 1)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const navItems = [
    { id: 'overview', label: '项目总览', icon: FilmReel },
    { id: 'library', label: '资料库', icon: Books, count: current?.chapters.length },
    { id: 'assets', label: '资产库', icon: Stack, count: current?.assets.length },
    { id: 'storyboard', label: '分镜工作台', icon: Rows, disabled: true },
    { id: 'tasks', label: '生成任务', icon: MonitorPlay, disabled: true },
    { id: 'requests', label: '提取记录', icon: FileText },
    { id: 'settings', label: '项目设置', icon: Gear },
  ] as const
  const titles: Record<View, [string, string, string]> = {
    overview: ['PROJECT OVERVIEW', '项目总览', '从完整原文到人物、场景与道具，查看真实提取进度。'],
    library: ['SOURCE LIBRARY', '资料库', '按章节阅读完整原文，资产引用可定位到对应段落。'],
    assets: [
      'WORLD BIBLE / ASSET LIBRARY',
      '资产库',
      '人物、场景与道具按已保存的实体归并结果展示。',
    ],
    requests: ['EXTRACTION LOG', '提取记录', '查看本章请求、失败原因与身份复核进度。'],
    settings: ['PROJECT SETTINGS', '项目设置', '查看当前项目与功能接入状态。'],
  }

  function renderProgress() {
    if (!current) return null
    return (
      <section className="ip-panel ip-live-progress" aria-label="真实提取进度">
        <div className="ip-live-progress-heading">
          <div>
            <p className="ip-eyebrow">EXTRACTION / LIVE DATA</p>
            <h3>{labels[current.status]}</h3>
          </div>
          <strong className="ip-live-percent">
            {percent}
            <small>%</small>
          </strong>
        </div>
        <progress
          aria-label="原文提取覆盖率"
          max={Math.max(1, current.sourceUtf16Length)}
          value={current.progress.coveredUtf16}
        />
        <p aria-live="polite">
          {current.progress.succeeded} / {current.progress.total} 分块成功 ·{' '}
          {current.progress.running} 处理中 · {current.progress.pending} 待处理 ·{' '}
          {current.progress.failed} 失败
        </p>
        <p className="ip-live-muted">
          原文覆盖率仅表示分块提取进度，不代表身份复核或视频生成完成。
        </p>
        {ai && (
          <p>
            身份复核：{labels[ai.status]} · {ai.subjectIds.length} 个对象 ·{' '}
            {ai.attempts.filter((item) => item.status === 'succeeded').length} 次请求成功 ·{' '}
            {
              ai.attempts.filter(
                (item) => item.status === 'failed' || item.status === 'interrupted',
              ).length
            }{' '}
            次失败 / 中断
          </p>
        )}
        {current.error && (
          <p className="ip-live-error" role="alert">
            {current.error}
          </p>
        )}
        <div className="ip-actions">
          <button
            type="button"
            className="ip-button primary"
            disabled={busy || current.status === 'running' || current.status === 'completed'}
            onClick={() => void analyze()}
          >
            <ArrowClockwise size={15} />
            {busy
              ? '正在提交…'
              : current.status === 'running'
                ? '正在分析'
                : current.status === 'completed'
                  ? '分析已完成'
                  : current.status === 'ready'
                    ? '开始全书分析'
                    : '继续 / 重试失败'}
          </button>
          <button type="button" className="ip-button" onClick={() => setView('requests')}>
            查看提取记录
          </button>
        </div>
        <p className="ip-live-muted">点击分析才会发送原文；继续任务复用成功分块。</p>
      </section>
    )
  }

  function renderLibrary() {
    if (!current) return null
    const visibleChapters = current.progress.chapters.filter((item) =>
      item.title.includes(chapterQuery.trim()),
    )
    return (
      <section className="ip-panel ip-library-layout">
        <aside className="ip-chapter-list" aria-label="章节列表">
          <div className="ip-chapter-list-header">
            <strong>{current.title}</strong>
            <span>
              完整原文 · {visibleChapters.length} / {current.chapters.length} 个部分
            </span>
            <label className="ip-chapter-search">
              <MagnifyingGlass size={14} />
              <input
                type="search"
                aria-label="搜索章节标题"
                placeholder="搜索章节标题"
                value={chapterQuery}
                onChange={(event) => setChapterQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="ip-chapter-list-items">
            {visibleChapters.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`ip-chapter-button ${chapterId === item.id ? 'is-active' : ''}`}
                aria-current={chapterId === item.id ? 'true' : undefined}
                onClick={() => chooseChapter(item.id)}
              >
                <span className="ip-chapter-number">
                  {item.number === null ? '序' : String(item.number).padStart(2, '0')}
                </span>
                <span>
                  <strong>{item.title}</strong>
                  <small data-status={item.status}>
                    {labels[item.status]} · {item.chunkIds.length} 个分块
                  </small>
                </span>
              </button>
            ))}
            {visibleChapters.length === 0 && (
              <p className="ip-chapter-empty">没有匹配的章节标题。</p>
            )}
          </div>
        </aside>
        <article className="ip-reading-pane">
          <div className="ip-reading-scroll" ref={readingPane}>
            <div className="ip-reading-meta">
              <span className="ip-tag accent">章节全文</span>
              <span>原文已保存</span>
            </div>
            <h2>{chapter?.title ?? '选择章节'}</h2>
            <div className="ip-source-quote">
              <FileText size={15} />
              <span>
                {chapter
                  ? `全文范围 [${chapter.start}, ${chapter.end}) · UTF-16 · 保留原始换行`
                  : '尚无章节'}
              </span>
            </div>
            {sourceError ? (
              <div className="ip-live-error" role="alert">
                {sourceError}
                <button
                  type="button"
                  className="ip-button"
                  onClick={() => setSourceRefresh((value) => value + 1)}
                >
                  重试读取章节
                </button>
              </div>
            ) : chapterText === null ? (
              <output>正在读取章节全文…</output>
            ) : (
              <>
                <pre className="ip-live-source" data-testid="chapter-full-text">
                  {range ? (
                    <>
                      {chapterText.slice(0, range.start)}
                      <mark ref={quoteMark}>{chapterText.slice(range.start, range.end)}</mark>
                      {chapterText.slice(range.end)}
                    </>
                  ) : (
                    chapterText
                  )}
                </pre>
                {quote && !range && (
                  <p className="ip-live-error" role="alert">
                    引用偏移与本章原文不匹配，请刷新后核对。
                  </p>
                )}
              </>
            )}
          </div>
        </article>
      </section>
    )
  }

  function renderAssets() {
    if (!current) return null
    return (
      <>
        <div className="ip-live-asset-controls">
          <div className="ip-asset-tabs" aria-label="资产类型">
            {kinds.map((kind) => (
              <button
                type="button"
                key={kind}
                className={`ip-tab ${filter === kind ? 'is-active' : ''}`}
                aria-pressed={filter === kind}
                onClick={() => {
                  setFilter(kind)
                  setPage(0)
                  setAssetId('')
                }}
              >
                {kind === 'all' ? '全部资产' : kindLabels[kind]}{' '}
                <span>
                  {kind === 'all'
                    ? catalog.length
                    : catalog.filter((asset) => asset.kind === kind).length}
                </span>
              </button>
            ))}
          </div>
          <label className="ip-chapter-search">
            <MagnifyingGlass size={14} />
            <input
              type="search"
              aria-label="搜索资产"
              placeholder="搜索名称或别名"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(0)
                setAssetId('')
              }}
            />
          </label>
        </div>
        <div className="ip-asset-grid">
          {pageAssets.map((asset) => (
            <button
              type="button"
              key={asset.id}
              className={`ip-asset-card ${selected?.id === asset.id ? 'is-selected' : ''}`}
              aria-pressed={selected?.id === asset.id}
              aria-controls="ip-live-asset-detail"
              onClick={() => {
                setAssetId(asset.id)
                detail.current?.scrollIntoView({ block: 'nearest' })
              }}
            >
              <div className={`ip-asset-thumb ${asset.kind}`}>
                <span className="ip-asset-thumb-icon">
                  <AssetSymbol kind={asset.kind} />
                </span>
                <span className="ip-asset-thumb-label">
                  {kindLabels[asset.kind]} · 类型图标 / 暂无参考图
                </span>
              </div>
              <div className="ip-asset-body">
                <h3>{asset.name}</h3>
                <p>{assetExcerpt(asset)}</p>
                <div className="ip-asset-footer">
                  <span className="ip-tag">{kindLabels[asset.kind]}</span>
                  <span>{asset.evidence.length} 条引用</span>
                </div>
              </div>
            </button>
          ))}
        </div>
        {assets.length === 0 && (
          <div className="ip-panel ip-live-empty">
            <h3>{current.assets.length ? '没有匹配资产' : '暂无已提取资产'}</h3>
            <p>
              {current.assets.length
                ? '试试其他类型、名称或别名。'
                : '完成原文提取后，人物、场景与道具将显示在这里。'}
            </p>
          </div>
        )}
        {assets.length > 0 && (
          <nav className="ip-live-pagination" aria-label="资产分页">
            <span>
              共 {assets.length} 项 · 第 {activePage + 1} / {pageCount} 页
            </span>
            <div className="ip-actions">
              <button
                type="button"
                className="ip-button"
                disabled={activePage === 0}
                onClick={() => {
                  setPage(activePage - 1)
                  setAssetId('')
                }}
              >
                上一页
              </button>
              <button
                type="button"
                className="ip-button"
                disabled={activePage + 1 >= pageCount}
                onClick={() => {
                  setPage(activePage + 1)
                  setAssetId('')
                }}
              >
                下一页
              </button>
            </div>
          </nav>
        )}
        {selected && (
          <section
            ref={detail}
            id="ip-live-asset-detail"
            className="ip-panel ip-asset-detail"
            aria-label="资产详情"
            key={selected.id}
          >
            <div className={`ip-asset-thumb ip-asset-detail-visual ${selected.kind}`}>
              <span className="ip-asset-thumb-icon">
                <AssetSymbol kind={selected.kind} size={68} />
              </span>
              <span className="ip-asset-thumb-label">类型图标 · 参考图未接入</span>
            </div>
            <div className="ip-asset-detail-copy">
              <p className="ip-eyebrow">
                {kindLabels[selected.kind]} / {selectedMembers ? '创作类别' : '原文提取'}
              </p>
              <h3>{selected.name}</h3>
              <p>{assetExcerpt(selected, 180)}</p>
              {selectedMembers?.map((member) => (
                <details key={member.id}>
                  <summary>
                    {member.name} · {member.evidence.length} 条引用
                  </summary>
                  {member.descriptions.map((description) => (
                    <p key={description}>{description}</p>
                  ))}
                  {member.evidence.map((e) => (
                    <button
                      type="button"
                      className="ip-button"
                      key={`${e.chunkId}:${e.start}`}
                      onClick={() => jumpToEvidence(e)}
                    >
                      {e.quote}
                    </button>
                  ))}
                </details>
              ))}
              <p className="ip-live-aliases">
                <strong>{selectedMembers ? '类别明细：' : '别名：'}</strong>
                {selected.aliases.join('、') || '无'}
              </p>
              <details className="ip-live-description">
                <summary>全部描述（{selected.descriptions.length}）</summary>
                {selected.descriptions.map((description, index) => (
                  <p key={`${selected.id}-${index}`}>{description}</p>
                ))}
              </details>
              <small className="ip-live-muted">摘要节选自首条有效描述；完整描述保留在上方。</small>
            </div>
            <div className="ip-asset-detail-side">
              <h4>原文来源</h4>
              <p>
                {selected.evidence.length} 条引用 ·{' '}
                {new Set(selected.evidence.map((item) => item.chapterId)).size} 个章节 / 部分
              </p>
              <p>
                {selectedMembers
                  ? '各明细保留独立身份与全部引用。'
                  : '保留已保存的归并结果与全部引用。'}
              </p>
              <button type="button" className="ip-button" disabled>
                生成参考图 · 未接入
              </button>
              <button type="button" className="ip-button" disabled>
                分镜绑定 · 未接入
              </button>
            </div>
            <div className="ip-live-evidence">
              <details>
                <summary>展开原文证据（{selected.evidence.length} 条）</summary>
                {selected.evidence.map((evidence, index) => (
                  <blockquote key={`${evidence.chunkId}-${evidence.start}-${index}`}>
                    <p>{evidence.quote}</p>
                    <button
                      type="button"
                      className="ip-button"
                      onClick={() => jumpToEvidence(evidence)}
                    >
                      {current.chapters.find((item) => item.id === evidence.chapterId)?.title ??
                        evidence.chapterId}{' '}
                      · 定位原文
                    </button>
                    <small>
                      原文范围 [{evidence.start}, {evidence.end})
                    </small>
                  </blockquote>
                ))}
              </details>
            </div>
          </section>
        )}
      </>
    )
  }

  function renderRequests() {
    if (!current) return null
    return (
      <>
        {renderProgress()}
        <section className="ip-panel ip-live-requests">
          <div className="ip-panel-heading">
            <h3>本章请求与错误</h3>
            <select
              aria-label="选择请求章节"
              value={chapterId}
              onChange={(event) => {
                setQuote(null)
                setChapterId(event.target.value)
              }}
            >
              {current.chapters.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </div>
          {chunks.map((chunk) => (
            <article key={chunk.id}>
              <h4>
                {chunk.id}{' '}
                <span className="ip-tag" data-status={chunk.status}>
                  {labels[chunk.status]}
                </span>
              </h4>
              <p>
                原文 [{chunk.start}, {chunk.end}) · {chunk.attempts.length} 次尝试
              </p>
              {chunk.error && <p className="ip-live-error">{chunk.error}</p>}
              {chunk.attempts.map((attempt) => (
                <details key={attempt.id}>
                  <summary>
                    {labels[attempt.status]} · {attempt.startedAt} · HTTP{' '}
                    {attempt.httpStatus ?? '无响应'}
                  </summary>
                  <pre>{JSON.stringify(attempt, null, 2)}</pre>
                </details>
              ))}
              {chunk.attempts.length === 0 && <p className="ip-live-muted">尚未发送请求。</p>}
            </article>
          ))}
          {ai && (
            <details className="ip-live-identity">
              <summary>身份复核审计 · {labels[ai.status]}</summary>
              {ai.attempts.map((attempt) => (
                <article key={attempt.id}>
                  <p>
                    {current.assets.find((asset) => asset.id === attempt.subjectId)?.name ??
                      attempt.subjectId}{' '}
                    · 第 {attempt.page + 1} 页 · {attempt.phase === 'verify' ? '复核' : '提案'} ·{' '}
                    {labels[attempt.status]}
                  </p>
                  {attempt.error && <p className="ip-live-error">{attempt.error}</p>}
                  {attempt.verdict && <p>{attempt.verdict.reason}</p>}
                </article>
              ))}
            </details>
          )}
        </section>
      </>
    )
  }

  return (
    <div className="ip-shell ip-live">
      <input
        ref={input}
        type="file"
        accept=".txt,.md"
        hidden
        onChange={(event) => void importFile(event.target.files?.[0])}
      />
      <header className="ip-topbar">
        <div className="ip-brand">
          <div className="ip-brand-mark">
            <FilmReel size={19} weight="bold" />
          </div>
          <div className="ip-brand-copy">
            <strong>镜界 / Scene Ledger</strong>
            <span>IP video studio</span>
          </div>
        </div>
        <label className="ip-project-switcher">
          <span>项目</span>
          <select
            aria-label="选择小说"
            value={id}
            disabled={busy || loading}
            onChange={(event) => setId(event.target.value)}
          >
            <option value="">选择已导入小说</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <div className="ip-top-actions">
          <span className="ip-top-status">
            <span className={`ip-status-dot ${connected ? '' : 'is-offline'}`} />
            真实数据 · {connected ? '进度已连接' : '进度未连接'}
          </span>
          <button type="button" className="ip-button" onClick={onDemo} disabled={busy}>
            独立演示
          </button>
        </div>
      </header>
      <div className="ip-body">
        <aside className="ip-rail">
          <div className="ip-rail-label">Workspace</div>
          <nav className="ip-nav" aria-label="项目导航">
            {navItems.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`ip-nav-button ${view === item.id ? 'is-active' : ''}`}
                aria-current={view === item.id ? 'page' : undefined}
                disabled={'disabled' in item && item.disabled}
                title={'disabled' in item ? `${item.label}未接入` : item.label}
                onClick={() => {
                  if (!('disabled' in item)) setView(item.id)
                }}
              >
                <item.icon size={17} weight={view === item.id ? 'fill' : 'regular'} />
                {item.label}
                {'disabled' in item ? (
                  <span className="ip-nav-count">未接入</span>
                ) : (
                  'count' in item && <span className="ip-nav-count">{item.count ?? '—'}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="ip-rail-bottom">
            <strong>真实项目</strong>原文、资产与提取记录来自已保存项目。参考图与视频生成尚未接入。
          </div>
        </aside>
        <main className="ip-content">
          <div className="ip-page-header">
            <div>
              <p className="ip-eyebrow">{titles[view][0]} · 真实模式</p>
              <h1>{titles[view][1]}</h1>
              <p>{titles[view][2]}</p>
            </div>
            <div className="ip-actions">
              <button
                type="button"
                className="ip-button"
                disabled={busy || loading}
                onClick={() => setRefresh((value) => value + 1)}
              >
                <ArrowClockwise size={15} />
                刷新结果
              </button>
              <button
                type="button"
                className="ip-button primary"
                disabled={busy}
                onClick={() => input.current?.click()}
              >
                <UploadSimple size={15} />
                导入小说
              </button>
            </div>
          </div>
          {[listError, projectError, actionError].filter(Boolean).map((error) => (
            <div className="ip-live-error" role="alert" key={error}>
              {error}
            </div>
          ))}
          {streamError && <output className="ip-live-notice">{streamError}</output>}
          {!current ? (
            <section className="ip-panel ip-live-empty">
              <Books size={40} weight="duotone" />
              <h2>
                {loading || (id && !projectError)
                  ? '正在读取真实项目…'
                  : id
                    ? '项目暂时无法读取'
                    : '从原文开始'}
              </h2>
              <p>
                {listError || projectError
                  ? '读取失败，请使用“刷新结果”重试。'
                  : '导入 UTF-8 小说，或选择已经保存的项目。'}
              </p>
              <p>导入只保存原文，点击“开始全书分析”后才会发起提取。</p>
            </section>
          ) : (
            <>
              {view === 'overview' && (
                <>
                  <div className="ip-progress-strip">
                    {[
                      ['01', '资料库', `${current.chapters.length} 个原文部分`, 'done'],
                      [
                        '02',
                        '资产提取',
                        `${current.assets.length} 项 · ${labels[current.status]}`,
                        current.status === 'completed' ? 'done' : 'current',
                      ],
                      ['03', '分镜', '未接入', ''],
                      ['04', '生成', '未接入', ''],
                    ].map(([number, label, description, state]) => (
                      <div key={number} className={`ip-progress-step ${state}`}>
                        <span>{number}</span>
                        <div>
                          <strong>{label}</strong>
                          <small>{description}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="ip-overview-grid">
                    <section className="ip-panel ip-live-project">
                      <div className="ip-live-book" aria-hidden="true">
                        <Books size={64} weight="duotone" />
                        <span>SOURCE / 原文</span>
                      </div>
                      <div className="ip-project-copy">
                        <p className="ip-eyebrow">CURRENT PROJECT / 真实数据</p>
                        <h2>{current.title}</h2>
                        <p>
                          {current.chapters.filter((item) => item.number !== null).length} 章 ·{' '}
                          {current.sourceCodePoints.toLocaleString()} 字符
                        </p>
                        <div className="ip-project-tags">
                          <span className="ip-tag accent">原文已保存</span>
                          <span className="ip-tag">{current.assets.length} 项资产</span>
                        </div>
                        <div className="ip-actions">
                          <button
                            type="button"
                            className="ip-button"
                            onClick={() => setView('library')}
                          >
                            阅读章节全文
                          </button>
                          <button
                            type="button"
                            className="ip-button"
                            onClick={() => setView('assets')}
                          >
                            查看资产库
                          </button>
                        </div>
                        <p className="ip-live-muted">
                          保存时间：{new Date(current.updatedAt).toLocaleString('zh-CN')}
                        </p>
                      </div>
                    </section>
                    {renderProgress()}
                  </div>
                  <div className="ip-stats-row">
                    {(['character', 'location', 'prop'] as const).map((kind) => (
                      <div className="ip-stat" key={kind}>
                        <span>{kindLabels[kind]}</span>
                        <strong>
                          {current.assets.filter((asset) => asset.kind === kind).length}
                        </strong>
                        <small>已保存的归并结果</small>
                      </div>
                    ))}
                    <div className="ip-stat">
                      <span>参考图 / 视频</span>
                      <strong>未接入</strong>
                      <small>生成操作暂不可用</small>
                    </div>
                  </div>
                </>
              )}
              {view === 'library' && renderLibrary()}
              {view === 'assets' && renderAssets()}
              {view === 'requests' && renderRequests()}
              {view === 'settings' && (
                <div className="ip-settings-grid">
                  <section className="ip-panel ip-settings-panel">
                    <h3>当前项目</h3>
                    <dl className="ip-live-settings">
                      {[
                        ['名称', current.title],
                        ['模型', current.model],
                        ['服务端点', current.endpoint],
                        ['提示词版本', current.promptVersion],
                        ['项目 ID', current.id],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <a
                      className="ip-button"
                      href={`${API}/projects/${id}/source`}
                      download={`${current.title}.txt`}
                    >
                      <DownloadSimple size={15} />
                      下载完整原文
                    </a>
                  </section>
                  <section className="ip-panel ip-settings-panel">
                    <h3>功能接入状态</h3>
                    <p>章节全文、资产提取、原文证据、失败重试：已接入。</p>
                    <p>实体归并：使用后端已保存结果，前端不修改身份决策。</p>
                    <p>参考图、分镜编排、视频生成、版本锁定：未接入。</p>
                    <button type="button" className="ip-button" disabled>
                      生成视频 · 未接入
                    </button>
                  </section>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
