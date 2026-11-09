import {
  ArrowUpRight,
  Books,
  Camera,
  CheckCircle,
  Clock,
  Cube,
  DownloadSimple,
  Eye,
  FileText,
  FilmReel,
  FloppyDisk,
  Gear,
  House,
  Lock,
  MagicWand,
  MagnifyingGlass,
  MonitorPlay,
  Plus,
  Rows,
  Sparkle,
  Stack,
  UploadSimple,
  User,
  WarningCircle,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type AssetKind,
  DEFAULT_ASSETS,
  DEFAULT_CHAPTERS,
  DEFAULT_SHOTS,
  DEFAULT_TASKS,
  type GenerationTask,
  type StoryChapter,
  type StudioAsset,
  type StudioShot,
  assetIconName,
  assetKindLabel,
} from '../data/ip-video-demo'
import './ip-video.css'
import './ip-video-live.css'
import { IPVideoLive } from './ip-video-live'

type StudioView = 'overview' | 'library' | 'assets' | 'storyboard' | 'tasks' | 'settings'
type ImportState = { kind: 'idle' | 'loading' | 'success' | 'error'; message: string }

const navItems: { id: StudioView; label: string; icon: typeof FilmReel; count?: string }[] = [
  { id: 'overview', label: '项目总览', icon: FilmReel },
  { id: 'library', label: '资料库', icon: Books, count: '244' },
  { id: 'assets', label: '资产库', icon: Stack, count: '5' },
  { id: 'storyboard', label: '分镜工作台', icon: Rows, count: '3' },
  { id: 'tasks', label: '生成任务', icon: MonitorPlay, count: '1' },
  { id: 'settings', label: '项目设置', icon: Gear },
]

const kindFilters: { id: 'all' | AssetKind; label: string }[] = [
  { id: 'all', label: '全部资产' },
  { id: 'character', label: '人物' },
  { id: 'location', label: '场景' },
  { id: 'prop', label: '道具' },
]

function formatTime(iso: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

function parseImportedChapters(text: string, fileName: string): StoryChapter[] {
  const matches = [...text.matchAll(/(^|\n)\s*(第[0-9一二三四五六七八九十百千]+章[^\n]*)/g)]
  if (matches.length === 0) {
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((item) => item.trim())
      .filter(Boolean)
    return [
      {
        id: 'imported-1',
        number: 1,
        title: fileName.replace(/\.(txt|md)$/i, ''),
        summary: '未检测到标准“第 N 章”标题，已按段落导入。',
        paragraphs,
        sourceLabel: `${fileName} · 导入文本`,
      },
    ]
  }

  return matches.map((match, index) => {
    const start = match.index ?? 0
    const end = matches[index + 1]?.index ?? text.length
    const block = text.slice(start, end).trim()
    const lines = block
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const title = lines[0] ?? `第 ${index + 1} 章`
    const titleEnd = block.indexOf(title) + title.length
    const paragraphs = block
      .slice(titleEnd)
      .split(/\n\s*\n/)
      .map((item) => item.trim())
      .filter(Boolean)
    return {
      id: `imported-${index + 1}`,
      number: index + 1,
      title,
      summary: paragraphs[0]?.slice(0, 90) ?? '已导入章节，等待进一步拆解。',
      paragraphs,
      sourceLabel: `${fileName} · ${title}`,
    }
  })
}

function IconForAsset({ kind, size = 32 }: { kind: AssetKind; size?: number }) {
  const iconName = assetIconName(kind)
  if (iconName === 'user') return <User size={size} weight="duotone" />
  if (iconName === 'house') return <House size={size} weight="duotone" />
  return <Cube size={size} weight="duotone" />
}

function composePrompt(shot: StudioShot, assets: StudioAsset[]) {
  const boundNames = shot.assetIds
    .map((id) => assets.find((asset) => asset.id === id))
    .filter(Boolean)
    .map((asset) => `${asset?.name} ${asset?.version}`)
  const binding = boundNames.length > 0 ? `固定资产：${boundNames.join('、')}。` : ''
  return `${binding}${shot.prompt}`
}

export function IPVideoPage() {
  const [demo, setDemo] = useState(false)
  if (!demo) return <IPVideoLive onDemo={() => setDemo(true)} />
  return (
    <>
      <div className="ip-demo-banner">
        <strong>独立演示 · 预置资产与模拟生成任务，不是真实 AI 分析结果</strong>
        <button type="button" onClick={() => setDemo(false)}>
          返回真实分析
        </button>
      </div>
      <IPVideoDemoPage />
    </>
  )
}

function IPVideoDemoPage() {
  const [view, setView] = useState<StudioView>('overview')
  const [chapters, setChapters] = useState(DEFAULT_CHAPTERS)
  const [selectedChapterId, setSelectedChapterId] = useState(DEFAULT_CHAPTERS[0].id)
  const [chapterSource, setChapterSource] = useState<'demo' | 'imported'>('demo')
  const [chapterQuery, setChapterQuery] = useState('')
  const [assets, setAssets] = useState(DEFAULT_ASSETS)
  const [assetFilter, setAssetFilter] = useState<'all' | AssetKind>('all')
  const [selectedAssetId, setSelectedAssetId] = useState(DEFAULT_ASSETS[0].id)
  const [shots, setShots] = useState(DEFAULT_SHOTS)
  const [selectedShotId, setSelectedShotId] = useState(DEFAULT_SHOTS[0].id)
  const [tasks, setTasks] = useState(DEFAULT_TASKS)
  const [prompt, setPrompt] = useState(DEFAULT_SHOTS[0].prompt)
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_SHOTS[0].negativePrompt)
  const [importState, setImportState] = useState<ImportState>({ kind: 'idle', message: '' })
  const [toast, setToast] = useState('')
  const [draggedShotId, setDraggedShotId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const readingPaneRef = useRef<HTMLElement>(null)

  const selectedChapter =
    chapters.find((chapter) => chapter.id === selectedChapterId) ?? chapters[0]
  const selectedShot = shots.find((shot) => shot.id === selectedShotId) ?? shots[0]
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) ?? assets[0]
  const visibleAssets = useMemo(
    () => assets.filter((asset) => assetFilter === 'all' || asset.kind === assetFilter),
    [assetFilter, assets],
  )
  const visibleChapters = useMemo(() => {
    const query = chapterQuery.trim().toLocaleLowerCase()
    if (!query) return chapters
    return chapters.filter((chapter) =>
      [chapter.title, chapter.summary, ...chapter.paragraphs].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    )
  }, [chapterQuery, chapters])

  useEffect(() => {
    if (!selectedShot) return
    setPrompt(selectedShot.prompt)
    setNegativePrompt(selectedShot.negativePrompt)
  }, [selectedShot])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    readingPaneRef.current?.scrollTo({ top: 0 })
  }, [selectedChapterId])

  function notify(message: string) {
    setToast(message)
  }

  function updateSelectedShot(patch: Partial<StudioShot>) {
    setShots((current) =>
      current.map((shot) => (shot.id === selectedShotId ? { ...shot, ...patch } : shot)),
    )
  }

  function chooseShot(shotId: string) {
    setSelectedShotId(shotId)
    setView('storyboard')
  }

  function handleImport(file?: File) {
    if (!file) return
    setImportState({ kind: 'loading', message: `正在解析 ${file.name}…` })
    void file
      .text()
      .then((text) => {
        const imported = parseImportedChapters(text, file.name)
        setChapters(imported)
        setSelectedChapterId(imported[0]?.id ?? '')
        setChapterSource('imported')
        setChapterQuery('')
        setImportState({
          kind: 'success',
          message: `解析完成：识别 ${imported.length} 个章节。原始文件仅在浏览器内读取，未上传。`,
        })
        setView('library')
        notify('小说已导入，章节列表已更新')
      })
      .catch(() => {
        setImportState({
          kind: 'error',
          message: '读取失败，请确认文件是 UTF-8 编码的 TXT 或 Markdown。',
        })
      })
  }

  function addDraftShot() {
    const source = selectedChapter?.paragraphs[0] ?? '从当前章节生成镜头草案。'
    const id = `shot-${Date.now()}`
    const newShot: StudioShot = {
      id,
      sequence: shots.length + 1,
      title: `新镜头 ${shots.length + 1}`,
      chapterId: selectedChapter?.id ?? chapters[0]?.id ?? 'chapter-1',
      sourceText: source,
      action: '根据段落补充动作和情绪变化。',
      camera: '中景 · 待设定',
      durationSec: 5,
      assetIds: ['asset-chen-shi', 'asset-courtyard', 'asset-horse'],
      prompt: '古代大乾世界，保持已锁定人物、场景和道具的一致性，电影化构图，竖屏 9:16。',
      negativePrompt: '现代元素，文字水印，人物变形，低清晰度。',
      status: 'draft',
    }
    setShots((current) => [...current, newShot])
    setSelectedShotId(id)
    setView('storyboard')
    notify('已从当前章节创建分镜草案')
  }

  function toggleShotAsset(assetId: string) {
    const nextAssetIds = selectedShot.assetIds.includes(assetId)
      ? selectedShot.assetIds.filter((id) => id !== assetId)
      : [...selectedShot.assetIds, assetId]
    const basePrompt = selectedShot.prompt.replace(/^固定资产：.*?。/, '')
    const nextPrompt = composePrompt(
      { ...selectedShot, assetIds: nextAssetIds, prompt: basePrompt },
      assets,
    )
    updateSelectedShot({ assetIds: nextAssetIds, prompt: nextPrompt })
    setPrompt(nextPrompt)
    notify('资产绑定已更新，Prompt 已同步')
  }

  function reorderShot(targetId: string) {
    if (!draggedShotId || draggedShotId === targetId) return
    setShots((current) => {
      const fromIndex = current.findIndex((shot) => shot.id === draggedShotId)
      const targetIndex = current.findIndex((shot) => shot.id === targetId)
      if (fromIndex < 0 || targetIndex < 0) return current
      const next = [...current]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(targetIndex, 0, moved)
      return next.map((shot, index) => ({ ...shot, sequence: index + 1 }))
    })
    setDraggedShotId(null)
    notify('镜头顺序已调整')
  }

  function scheduleTask(task: GenerationTask) {
    setTasks((current) => [task, ...current])
    window.setTimeout(() => {
      setTasks((current) =>
        current.map((item) => (item.id === task.id ? { ...item, status: 'running' } : item)),
      )
    }, 700)
    window.setTimeout(() => {
      setTasks((current) =>
        current.map((item) =>
          item.id === task.id
            ? {
                ...item,
                status: 'succeeded',
                completedAt: new Date().toISOString(),
                resultUrl: item.type === 'video' ? '/demo/ride-servant-shot-01.mp4' : undefined,
              }
            : item,
        ),
      )
      setShots((current) =>
        current.map((shot) => (shot.id === task.shotId ? { ...shot, status: 'generated' } : shot)),
      )
      notify(`${task.type === 'video' ? '视频' : '图片'}任务已完成，本地结果可预览`)
    }, 2800)
  }

  function createTask(type: 'image' | 'video') {
    const now = new Date().toISOString()
    const boundVersions = selectedShot.assetIds
      .map((id) => assets.find((asset) => asset.id === id))
      .filter(Boolean)
      .map((asset) => `${asset?.name} ${asset?.version}`)
    const task: GenerationTask = {
      id: `gen_local_${Date.now()}`,
      shotId: selectedShot.id,
      type,
      provider: type === 'video' ? 'MiniMax Adapter · local mock' : 'Local Preview Adapter',
      model: type === 'video' ? 'MiniMax-H3' : 'image-preview-v1',
      status: 'queued',
      createdAt: now,
      requestSummary:
        type === 'video'
          ? '{"ratio":"9:16","resolution":"2K","durationSec":5,"vaultRef":"configured"}'
          : '{"ratio":"9:16","resolution":"2K","seedPolicy":"stable"}',
      assetVersions: boundVersions,
      prompt,
    }
    scheduleTask(task)
    setView('tasks')
    notify(`已创建${type === 'video' ? '视频' : '图片'}生成任务，状态：排队中`)
  }

  function retryTask(task: GenerationTask) {
    const shot = shots.find((item) => item.id === task.shotId)
    if (!shot) return
    const retry: GenerationTask = {
      ...task,
      id: `gen_retry_${Date.now()}`,
      status: 'queued',
      createdAt: new Date().toISOString(),
      completedAt: undefined,
      errorMessage: undefined,
    }
    scheduleTask(retry)
    notify('已创建重试任务')
  }

  function updateAssetStatus(assetId: string) {
    setAssets((current) =>
      current.map((asset) =>
        asset.id === assetId
          ? { ...asset, status: asset.status === 'locked' ? 'review' : 'locked' }
          : asset,
      ),
    )
    notify('资产锁定状态已更新')
  }

  function renderOverview() {
    return (
      <>
        <div className="ip-page-header">
          <div>
            <p className="ip-eyebrow">IP VIDEO CONSISTENCY STUDIO</p>
            <h1>把小说，拆成可复用的镜头资产。</h1>
            <p>围绕原文来源、锁定资产和生成任务，完成第一条可追溯的视频镜头。</p>
          </div>
          <div className="ip-actions">
            <button
              type="button"
              className="ip-button"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadSimple size={15} />
              导入小说
            </button>
            <button
              type="button"
              className="ip-button primary"
              onClick={() => setView('storyboard')}
            >
              <Rows size={15} />
              打开分镜工作台
            </button>
          </div>
        </div>
        <div className="ip-progress-strip">
          {[
            ['01', '资料库', '1 个源文件', 'done'],
            ['02', '世界观', '5 个资产已锁定', 'done'],
            ['03', '分镜', `${shots.length} 个镜头草案`, 'current'],
            ['04', '生成', `${tasks.length} 条任务记录`, ''],
          ].map(([number, label, detail, state]) => (
            <div key={number} className={`ip-progress-step ${state}`}>
              <span>{number}</span>
              <div>
                <strong>{label}</strong>
                <small>{detail}</small>
              </div>
            </div>
          ))}
        </div>
        <div className="ip-overview-grid">
          <section className="ip-panel ip-project-panel">
            <div className="ip-video-cover">
              <video
                src="/demo/ride-servant-shot-01.mp4"
                muted
                loop
                autoPlay
                playsInline
                controls
              />
            </div>
            <div className="ip-project-copy">
              <p className="ip-eyebrow">CURRENT PROJECT · DEMO 01</p>
              <h2>从骑奴到大乾武圣</h2>
              <p>
                首个验收 Demo：陈实牵马回院，萧凤箫带人闯入。固定资产版本贯穿镜头、Prompt
                与生成任务。
              </p>
              <div className="ip-meta-line">
                <span>
                  最近修改 <b>今天 08:36</b>
                </span>
                <span>
                  所有者 <b>本地工作区</b>
                </span>
              </div>
              <div className="ip-project-tags">
                <span className="ip-tag accent">9:16 竖屏</span>
                <span className="ip-tag">2K</span>
                <span className="ip-tag">MiniMax-H3</span>
                <span className="ip-tag">资产锁定 5/5</span>
              </div>
            </div>
          </section>
          <section className="ip-panel ip-activity-panel">
            <div className="ip-panel-heading">
              <h3>最近活动</h3>
              <span>local log</span>
            </div>
            <div className="ip-activity-list">
              <div className="ip-activity-item">
                <div className="ip-activity-icon">
                  <CheckCircle size={16} />
                </div>
                <div>
                  <strong>视频镜头已生成</strong>
                  <small>镜头 01 · 结果已写入任务记录</small>
                </div>
                <span className="ip-activity-time">08:36</span>
              </div>
              <div className="ip-activity-item">
                <div className="ip-activity-icon">
                  <Lock size={16} />
                </div>
                <div>
                  <strong>资产版本已锁定</strong>
                  <small>陈实、甜水巷小院、黑马</small>
                </div>
                <span className="ip-activity-time">08:31</span>
              </div>
              <div className="ip-activity-item">
                <div className="ip-activity-icon">
                  <FileText size={16} />
                </div>
                <div>
                  <strong>章节解析完成</strong>
                  <small>当前载入 {chapters.length} 章 · 正文可滚动阅读</small>
                </div>
                <span className="ip-activity-time">08:28</span>
              </div>
            </div>
          </section>
        </div>
        <div className="ip-stats-row">
          <div className="ip-stat">
            <span>章节</span>
            <strong>{chapters.length}</strong>
            <small>{chapterSource === 'demo' ? '完整 Demo 示例' : '当前载入章节'}</small>
          </div>
          <div className="ip-stat">
            <span>锁定资产</span>
            <strong>5</strong>
            <small>人物 / 场景 / 道具</small>
          </div>
          <div className="ip-stat">
            <span>镜头草案</span>
            <strong>{shots.length}</strong>
            <small>当前项目</small>
          </div>
          <div className="ip-stat">
            <span>生成结果</span>
            <strong>{tasks.filter((task) => task.status === 'succeeded').length}</strong>
            <small>可预览任务</small>
          </div>
        </div>
      </>
    )
  }

  function renderLibrary() {
    return (
      <>
        <div className="ip-page-header">
          <div>
            <p className="ip-eyebrow">SOURCE LIBRARY</p>
            <h2>资料库</h2>
            <p>原文保留可引用来源；导入、解析和章节选择都在本地完成。</p>
          </div>
          <div className="ip-actions">
            <button
              type="button"
              className="ip-button primary"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadSimple size={15} />
              导入 TXT / Markdown
            </button>
          </div>
        </div>
        {importState.kind !== 'idle' && (
          <div className={`ip-import-state ${importState.kind === 'error' ? 'error' : ''}`}>
            {importState.kind === 'error' ? <WarningCircle size={16} /> : <CheckCircle size={16} />}
            {importState.message}
          </div>
        )}
        <section className="ip-panel ip-library-layout">
          <aside className="ip-chapter-list">
            <div className="ip-chapter-list-header">
              <strong>从骑奴到大乾武圣</strong>
              <span>
                {chapterSource === 'demo' ? 'Demo 完整示例' : '原文已导入'} · 显示{' '}
                {visibleChapters.length}/{chapters.length} 章
              </span>
              <label className="ip-chapter-search">
                <MagnifyingGlass size={14} />
                <input
                  type="search"
                  value={chapterQuery}
                  onChange={(event) => setChapterQuery(event.target.value)}
                  placeholder="搜索章节或正文"
                  aria-label="搜索章节或正文"
                />
              </label>
            </div>
            <div className="ip-chapter-list-items">
              {visibleChapters.length > 0 ? (
                visibleChapters.map((chapter) => (
                  <button
                    type="button"
                    key={chapter.id}
                    className={`ip-chapter-button ${chapter.id === selectedChapterId ? 'is-active' : ''}`}
                    onClick={() => setSelectedChapterId(chapter.id)}
                  >
                    <span className="ip-chapter-number">
                      {String(chapter.number).padStart(2, '0')}
                    </span>
                    <span>
                      <strong>
                        {chapter.title.replace(/^第[0-9一二三四五六七八九十百千]+章\s*/, '')}
                      </strong>
                      <small>{chapter.summary}</small>
                    </span>
                  </button>
                ))
              ) : (
                <p className="ip-chapter-empty">没有匹配的章节或正文。</p>
              )}
            </div>
          </aside>
          {selectedChapter ? (
            <article className="ip-reading-pane" ref={readingPaneRef}>
              <div className="ip-reading-scroll">
                <div className="ip-reading-meta">
                  <span className="ip-tag accent">第 {selectedChapter.number} 章</span>
                  <span>{selectedChapter.sourceLabel}</span>
                </div>
                <h2>{selectedChapter.title}</h2>
                <p className="ip-reading-summary">{selectedChapter.summary}</p>
                <blockquote className="ip-source-quote">
                  <Eye size={15} />
                  <span>完整正文 · {selectedChapter.paragraphs.length} 段 · 当前阅读区未截断</span>
                </blockquote>
                <div className="ip-reading-copy">
                  {selectedChapter.paragraphs.map((paragraph, index) => (
                    <p key={`${selectedChapter.id}-${index}`}>{paragraph}</p>
                  ))}
                </div>
              </div>
            </article>
          ) : (
            <div className="ip-reading-pane ip-reading-empty">请选择一个章节开始阅读。</div>
          )}
        </section>
      </>
    )
  }

  function renderAssets() {
    return (
      <>
        <div className="ip-page-header">
          <div>
            <p className="ip-eyebrow">WORLD BIBLE / ASSET LIBRARY</p>
            <h2>资产库</h2>
            <p>先锁定一致性基准，再让镜头和生成任务引用同一套版本。</p>
          </div>
          <div className="ip-actions">
            <button type="button" className="ip-button">
              <Plus size={15} />
              新建资产
            </button>
            <button
              type="button"
              className="ip-button primary"
              onClick={() => setView('storyboard')}
            >
              <MagicWand size={15} />
              去分镜绑定
            </button>
          </div>
        </div>
        <div className="ip-asset-tabs">
          {kindFilters.map((filter) => (
            <button
              type="button"
              key={filter.id}
              className={`ip-tab ${filter.id === assetFilter ? 'is-active' : ''}`}
              onClick={() => setAssetFilter(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="ip-asset-grid">
          {visibleAssets.map((asset) => (
            <button
              type="button"
              key={asset.id}
              className={`ip-asset-card ${asset.id === selectedAssetId ? 'is-selected' : ''}`}
              onClick={() => setSelectedAssetId(asset.id)}
            >
              <div className={`ip-asset-thumb ${asset.kind}`}>
                <span className="ip-asset-thumb-icon">
                  <IconForAsset kind={asset.kind} size={43} />
                </span>
                <span className="ip-asset-thumb-label">
                  {assetKindLabel(asset.kind).toUpperCase()}
                </span>
              </div>
              <div className="ip-asset-body">
                <h3>{asset.name}</h3>
                <p>{asset.subtitle}</p>
                <div className="ip-asset-footer">
                  <span className="ip-tag">{asset.version}</span>
                  <span className="ip-lock">
                    <Lock size={12} weight="bold" />
                    {asset.status === 'locked' ? '已锁定' : '待确认'}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
        <section className="ip-panel ip-asset-detail">
          <div className={`ip-asset-thumb ip-asset-detail-visual ${selectedAsset.kind}`}>
            <span className="ip-asset-thumb-icon">
              <IconForAsset kind={selectedAsset.kind} size={68} />
            </span>
            <span className="ip-asset-thumb-label">{selectedAsset.version} REFERENCE</span>
          </div>
          <div className="ip-asset-detail-copy">
            <p className="ip-eyebrow">
              {assetKindLabel(selectedAsset.kind)} / 版本 {selectedAsset.version}
            </p>
            <h3>{selectedAsset.name}</h3>
            <p>{selectedAsset.description}</p>
            <div className="ip-feature-list">
              {selectedAsset.features.map((feature) => (
                <span className="ip-tag" key={feature}>
                  {feature}
                </span>
              ))}
            </div>
          </div>
          <div className="ip-asset-detail-side">
            <h4>原文来源</h4>
            <p>“{selectedAsset.sourceQuote}”</p>
            <button
              type="button"
              className="ip-button"
              style={{ marginTop: 15 }}
              onClick={() => updateAssetStatus(selectedAsset.id)}
            >
              {selectedAsset.status === 'locked' ? <Lock size={14} /> : <CheckCircle size={14} />}
              {selectedAsset.status === 'locked' ? '解锁复核' : '锁定版本'}
            </button>
          </div>
        </section>
      </>
    )
  }

  function renderStoryboard() {
    return (
      <>
        <div className="ip-page-header">
          <div>
            <p className="ip-eyebrow">SHOT DESIGN WORKSPACE</p>
            <h2>分镜工作台</h2>
            <p>从原文段落进入镜头，绑定锁定资产，再生成可追溯的图片或视频任务。</p>
          </div>
          <div className="ip-actions">
            <button type="button" className="ip-button" onClick={addDraftShot}>
              <Sparkle size={15} />
              从章节生成草案
            </button>
            <button type="button" className="ip-button primary" onClick={() => createTask('video')}>
              <MonitorPlay size={15} />
              生成 5 秒视频
            </button>
          </div>
        </div>
        <section className="ip-panel ip-workspace">
          <aside className="ip-workspace-source">
            <div className="ip-workspace-source-header">
              <strong>镜头清单</strong>
              <span>拖拽底部时间线调整顺序</span>
            </div>
            {shots.map((shot) => (
              <button
                type="button"
                key={shot.id}
                className={`ip-source-shot ${shot.id === selectedShotId ? 'is-active' : ''}`}
                onClick={() => chooseShot(shot.id)}
              >
                <span className="ip-source-shot-number">
                  {String(shot.sequence).padStart(2, '0')}
                </span>
                <span>
                  <strong>{shot.title}</strong>
                  <small>
                    {shot.durationSec}s · {shot.status === 'generated' ? '已有结果' : '待生成'}
                  </small>
                </span>
              </button>
            ))}
          </aside>
          <div className="ip-canvas">
            <div className="ip-canvas-toolbar">
              <div>
                <strong>
                  镜头 {String(selectedShot.sequence).padStart(2, '0')} · {selectedShot.title}
                </strong>
                <span style={{ display: 'block', marginTop: 4 }}>
                  {selectedShot.camera} · {selectedShot.durationSec}s
                </span>
              </div>
              <button
                type="button"
                className="ip-icon-button"
                title="预览镜头"
                onClick={() => notify('预览使用当前镜头版本')}
              >
                <PlayCircleIcon />
              </button>
            </div>
            <div className="ip-preview-stage">
              {selectedShot.id === 'shot-1' ||
              tasks.some((task) => task.shotId === selectedShot.id && task.resultUrl) ? (
                <video
                  src="/demo/ride-servant-shot-01.mp4"
                  muted
                  loop
                  autoPlay
                  playsInline
                  controls
                  aria-label={`${selectedShot.title} 视频预览`}
                />
              ) : (
                <div className="ip-preview-placeholder">
                  <Camera size={52} weight="duotone" />
                  <span className="ip-preview-caption">
                    STORYBOARD FRAME / {selectedShot.status.toUpperCase()}
                  </span>
                </div>
              )}
            </div>
            <p className="ip-canvas-note">
              画幅 9:16 · 2K · 当前预览来自本地 Demo 结果；新任务会在生成任务页记录状态和版本。
            </p>
          </div>
          <aside className="ip-inspector">
            <div className="ip-inspector-header">
              <strong>镜头字段</strong>
              <span>修改会即时保留在本地状态</span>
            </div>
            <div className="ip-inspector-scroll">
              <div className="ip-field">
                <label htmlFor="shot-title">镜头标题</label>
                <input
                  id="shot-title"
                  value={selectedShot.title}
                  onChange={(event) => updateSelectedShot({ title: event.target.value })}
                />
              </div>
              <div className="ip-field">
                <label htmlFor="shot-action">动作与情绪</label>
                <textarea
                  id="shot-action"
                  value={selectedShot.action}
                  onChange={(event) => updateSelectedShot({ action: event.target.value })}
                />
              </div>
              <div className="ip-field">
                <label htmlFor="shot-camera">镜头语言</label>
                <select
                  id="shot-camera"
                  value={selectedShot.camera}
                  onChange={(event) => updateSelectedShot({ camera: event.target.value })}
                >
                  <option>中近景 · 低机位跟拍</option>
                  <option>广角远景 → 推近特写</option>
                  <option>固定中景 · 门外声先入</option>
                  <option>特写 · 眼神停顿</option>
                </select>
              </div>
              <div className="ip-field">
                <span className="ip-field-label">绑定资产</span>
                <div className="ip-binding-list">
                  {assets.map((asset) => (
                    <button
                      type="button"
                      key={asset.id}
                      className={`ip-binding ${selectedShot.assetIds.includes(asset.id) ? 'is-bound' : ''}`}
                      onClick={() => toggleShotAsset(asset.id)}
                    >
                      {selectedShot.assetIds.includes(asset.id) ? (
                        <CheckCircle size={12} />
                      ) : (
                        <Plus size={12} />
                      )}
                      {asset.name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ip-field">
                <label htmlFor="shot-prompt">Prompt · v1</label>
                <textarea
                  id="shot-prompt"
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value)
                    updateSelectedShot({ prompt: event.target.value })
                  }}
                />
              </div>
              <div className="ip-field">
                <label htmlFor="shot-negative-prompt">Negative Prompt</label>
                <textarea
                  id="shot-negative-prompt"
                  value={negativePrompt}
                  onChange={(event) => {
                    setNegativePrompt(event.target.value)
                    updateSelectedShot({ negativePrompt: event.target.value })
                  }}
                />
              </div>
              <div className="ip-inspector-actions">
                <button type="button" className="ip-button" onClick={() => createTask('image')}>
                  <Eye size={14} />
                  生成图片预览
                </button>
                <button
                  type="button"
                  className="ip-button primary"
                  onClick={() => createTask('video')}
                >
                  <MonitorPlay size={14} />
                  创建视频任务
                </button>
                <span className="ip-status-label">
                  <Lock size={11} />
                  任务只保存脱敏参数，Token 由 Vault 引用
                </span>
              </div>
            </div>
          </aside>
        </section>
        <section className="ip-panel ip-timeline">
          <div className="ip-timeline-header">
            <strong>镜头时间线</strong>
            <span>拖拽镜头卡片可调整顺序</span>
          </div>
          <div className="ip-timeline-track">
            {shots.map((shot) => (
              <button
                type="button"
                key={shot.id}
                draggable
                className={`ip-shot-item ${shot.id === selectedShotId ? 'is-active' : ''}`}
                onClick={() => setSelectedShotId(shot.id)}
                onDragStart={() => setDraggedShotId(shot.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => reorderShot(shot.id)}
              >
                <small>
                  SHOT {String(shot.sequence).padStart(2, '0')} · {shot.durationSec}.0s
                </small>
                <strong>{shot.title}</strong>
                <span>
                  {shot.assetIds.length} 个资产 · {shot.status === 'generated' ? '已生成' : '草案'}
                </span>
              </button>
            ))}
          </div>
        </section>
      </>
    )
  }

  function renderTasks() {
    return (
      <>
        <div className="ip-page-header">
          <div>
            <p className="ip-eyebrow">GENERATION LEDGER</p>
            <h2>生成任务</h2>
            <p>查看任务状态、Provider 任务 ID、脱敏请求参数、资产版本和结果文件。</p>
          </div>
          <div className="ip-actions">
            <button type="button" className="ip-button" onClick={() => setView('storyboard')}>
              <Rows size={15} />
              返回分镜
            </button>
          </div>
        </div>
        <div className="ip-task-list">
          {tasks.map((task) => {
            const shot = shots.find((item) => item.id === task.shotId)
            return (
              <article className="ip-panel ip-task-row" key={task.id}>
                <div className="ip-task-type">
                  {task.type === 'video' ? <MonitorPlay size={19} /> : <Eye size={19} />}
                </div>
                <div className="ip-task-main">
                  <strong>
                    {shot?.title ?? '未命名镜头'} · {task.type === 'video' ? '视频' : '图片'}预览
                  </strong>
                  <small>
                    {task.id} · {task.provider}
                  </small>
                  <div className={`ip-task-status ${task.status}`}>
                    {task.status === 'succeeded' ? <CheckCircle size={13} /> : <Clock size={13} />}
                    {task.status === 'succeeded'
                      ? `已完成 ${task.completedAt ? formatTime(task.completedAt) : ''}`
                      : task.status === 'running'
                        ? '执行中'
                        : task.status === 'queued'
                          ? '排队中'
                          : '失败'}
                  </div>
                </div>
                <div className="ip-task-detail">
                  <span className="ip-task-label">脱敏参数</span>
                  <pre>{task.requestSummary}</pre>
                  <span className="ip-task-label" style={{ marginTop: 12 }}>
                    资产版本
                  </span>
                  <p>{task.assetVersions.join(' · ') || '未绑定资产'}</p>
                </div>
                <div className="ip-task-detail ip-task-result">
                  <span className="ip-task-label">结果与 Prompt</span>
                  {task.resultUrl ? (
                    <a className="ip-result-link" href={task.resultUrl} download>
                      <DownloadSimple size={13} />
                      预览 / 下载结果
                    </a>
                  ) : (
                    <p>任务完成后显示结果文件</p>
                  )}
                  <p style={{ marginTop: 8 }}>{task.prompt.slice(0, 110)}…</p>
                </div>
                <div className="ip-task-actions">
                  <button
                    type="button"
                    className="ip-icon-button"
                    title="打开关联镜头"
                    onClick={() => chooseShot(task.shotId)}
                  >
                    <ArrowUpRight size={15} />
                  </button>
                  <button
                    type="button"
                    className="ip-icon-button"
                    title="重试任务"
                    onClick={() => retryTask(task)}
                  >
                    <FloppyDisk size={15} />
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      </>
    )
  }

  function renderSettings() {
    return (
      <>
        <div className="ip-page-header">
          <div>
            <p className="ip-eyebrow">PROJECT CONTRACT</p>
            <h2>项目设置</h2>
            <p>Demo 的固定输出参数与 Provider 抽象接口在此集中展示。</p>
          </div>
          <div className="ip-actions">
            <button
              type="button"
              className="ip-button primary"
              onClick={() => notify('项目设置已保存在本地原型状态')}
            >
              <FloppyDisk size={15} />
              保存设置
            </button>
          </div>
        </div>
        <div className="ip-settings-grid">
          <section className="ip-panel ip-settings-panel">
            <h3>项目默认值</h3>
            {[
              ['项目名称', '从骑奴到大乾武圣'],
              ['默认画幅', '9:16 竖屏'],
              ['默认分辨率', '2K'],
              ['默认时长', '5 秒'],
              ['默认模型', 'MiniMax-H3'],
            ].map(([label, value]) => (
              <div className="ip-setting-row" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </section>
          <section className="ip-panel ip-settings-panel">
            <h3>生成边界</h3>
            {[
              ['Provider', 'VideoProvider Adapter'],
              ['任务记录', '本地状态模拟'],
              ['Token', 'Vault 引用，不显示'],
              ['结果资产', '必须绑定版本'],
              ['外部写入', '关闭'],
            ].map(([label, value]) => (
              <div className="ip-setting-row" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </section>
        </div>
      </>
    )
  }

  return (
    <div className="ip-shell">
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,text/plain,text/markdown"
        hidden
        onChange={(event) => handleImport(event.target.files?.[0])}
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
        <div className="ip-project-switcher">
          <span>项目</span>
          <strong>从骑奴到大乾武圣</strong>
          <ArrowUpRight size={14} color="#9a9d95" />
        </div>
        <div className="ip-top-actions">
          <div className="ip-top-status">
            <span className="ip-status-dot" />
            本地原型 · 未发布
          </div>
          <button
            type="button"
            className="ip-icon-button"
            title="项目设置"
            onClick={() => setView('settings')}
          >
            <Gear size={16} />
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
                onClick={() => setView(item.id)}
              >
                <item.icon size={17} weight={view === item.id ? 'fill' : 'regular'} />
                {item.label}
                {item.count && (
                  <span className="ip-nav-count">
                    {item.id === 'assets'
                      ? assets.length
                      : item.id === 'library'
                        ? chapters.length
                        : item.count}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="ip-rail-bottom">
            <strong>Demo / 01</strong>
            原文、资产、Prompt 和生成记录在当前浏览器会话中联动。
          </div>
        </aside>
        <main className="ip-content">
          {view === 'overview' && renderOverview()}
          {view === 'library' && renderLibrary()}
          {view === 'assets' && renderAssets()}
          {view === 'storyboard' && renderStoryboard()}
          {view === 'tasks' && renderTasks()}
          {view === 'settings' && renderSettings()}
        </main>
      </div>
      {toast && <div className="ip-toast">{toast}</div>}
    </div>
  )
}

function PlayCircleIcon() {
  return <Sparkle size={16} />
}
