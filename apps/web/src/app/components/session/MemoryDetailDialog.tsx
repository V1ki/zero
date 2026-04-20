import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MemoryRetrievalSelectedMemory } from './memory-retrieval'

interface Props {
  memory: MemoryRetrievalSelectedMemory | null
  onClose: () => void
}

export function MemoryDetailDialog({ memory, onClose }: Props) {
  const [memoryContent, setMemoryContent] = useState<string | null>(null)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryError, setMemoryError] = useState<string | null>(null)

  useEffect(() => {
    if (!memory) return

    const controller = new AbortController()
    setMemoryLoading(true)
    setMemoryContent(null)
    setMemoryError(null)

    void fetch(`/api/memory/${memory.type}/${memory.id}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.status === 404) throw new Error('deleted')
        if (!res.ok) throw new Error('fetch_failed')
        return res.json() as Promise<{ memory?: { content?: string } }>
      })
      .then((data) => setMemoryContent(data.memory?.content ?? ''))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setMemoryError(
          error instanceof Error && error.message === 'deleted'
            ? '该记忆已被删除或归档。'
            : '加载失败。',
        )
      })
      .finally(() => setMemoryLoading(false))

    return () => controller.abort()
  }, [memory])

  useEffect(() => {
    if (!memory) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [memory, onClose])

  if (!memory) return null

  return (
    <div
      data-testid="memory-detail-dialog"
      className="fixed inset-0 z-[90] flex items-center justify-center overlay-enter"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="card mx-4 w-full max-w-[760px] dialog-enter"
        style={{
          background: 'var(--color-float)',
          boxShadow:
            '0 8px 40px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
        }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] p-4">
          <div className="space-y-2">
            <h4 className="text-[15px] font-semibold text-[var(--color-text-primary)]">
              {memory.title}
            </h4>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
              <span className="rounded bg-white/5 px-2 py-1 font-mono">{memory.type}</span>
              <code className="text-[var(--color-text-muted)]">{memory.id}</code>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[var(--color-border)] px-2.5 py-1 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-white/[0.04]"
          >
            Close
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {memoryLoading && <p className="text-[13px] text-[var(--color-text-muted)]">Loading...</p>}
          {memoryError && <p className="text-[13px] text-red-300">{memoryError}</p>}
          {!memoryLoading && !memoryError && memoryContent !== null && (
            <div className="prose prose-invert max-w-none text-[13px] text-[var(--color-text-secondary)]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{memoryContent}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
