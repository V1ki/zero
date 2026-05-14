import { ArrowLeft, CheckCircle, MagnifyingGlass, X } from '@phosphor-icons/react'
import { useNavigate, useParams } from '@tanstack/react-router'
import type { SourceCard, SourceCardState } from '@zero-os/shared'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Skeleton } from '../components/shared/Skeleton'
import { apiFetch, apiPost } from '../lib/api'
import { formatTimeAgo } from '../lib/format'

export type SourceCardPublicView = SourceCard

interface SourceCardListResponse {
  sourceCards: SourceCardPublicView[]
}

export interface SourceCardActivationPayload {
  reason: string
}

type StateFilter = 'all' | SourceCardState
type SensitivityFilter = 'all' | SourceCard['sensitivity']
type ReadinessTone = 'draft' | 'active' | 'retired'

const STATE_FILTERS: StateFilter[] = ['all', 'draft', 'active', 'retired']
const SENSITIVITY_FILTERS: SensitivityFilter[] = [
  'all',
  'public',
  'internal',
  'private',
  'restricted',
]
const SOURCE_CARDS_CHANGED_EVENT = 'zero:source-cards:changed'

const STATE_STYLES: Record<SourceCardState, { dot: string; text: string; bg: string }> = {
  draft: { dot: 'bg-amber-400', text: 'text-amber-400', bg: 'bg-amber-400/10' },
  active: { dot: 'bg-emerald-400', text: 'text-emerald-400', bg: 'bg-emerald-400/10' },
  retired: { dot: 'bg-slate-600', text: 'text-slate-500', bg: 'bg-slate-400/10' },
}

const READINESS_STYLES: Record<ReadinessTone, string> = {
  draft: 'bg-amber-400/10 text-amber-400',
  active: 'bg-emerald-400/10 text-emerald-400',
  retired: 'bg-slate-400/10 text-slate-500',
}

function formatLabel(value: string): string {
  return value.replaceAll('_', ' ')
}

function updatedLabel(card: SourceCardPublicView): string {
  if (card.updatedAt) return formatTimeAgo(card.updatedAt)
  return 'Never'
}

function sourceSummary(card: SourceCardPublicView): string {
  return card.source?.summary ?? firstSourceDocLine(card) ?? 'Markdown source guide'
}

function firstSourceDocLine(card: SourceCardPublicView): string | undefined {
  return card.sourceDoc.body
    .split('\n')
    .map((line) => line.replace(/^[-#\s]+/, '').trim())
    .find((line) => line.length > 0)
}

export function getSourceCardReadiness(card: SourceCardPublicView): {
  label: string
  tone: ReadinessTone
  detail: string
} {
  if (card.state === 'active') {
    return {
      label: 'Active',
      tone: 'active',
      detail: 'Ready for preflight use. Read sourceDoc before using tools.',
    }
  }
  if (card.state === 'retired') {
    return {
      label: 'Retired',
      tone: 'retired',
      detail: 'Kept for history only. Do not use for new data-source requests.',
    }
  }
  return {
    label: 'Draft review',
    tone: 'draft',
    detail: 'Review the Markdown guide, then activate only when it is safe and useful.',
  }
}

export function SourceStateBadge({ state }: { state: SourceCardState }) {
  const style = STATE_STYLES[state]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium ${style.bg} ${style.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {state}
    </span>
  )
}

function ReadinessBadge({ card }: { card: SourceCardPublicView }) {
  const readiness = getSourceCardReadiness(card)
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${READINESS_STYLES[readiness.tone]}`}
      title={readiness.detail}
    >
      {readiness.label}
    </span>
  )
}

export function SourceCardTableView({
  sourceCards,
  onOpen,
}: {
  sourceCards: SourceCardPublicView[]
  onOpen: (id: string) => void
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
      <table className="w-full table-fixed text-left">
        <thead className="border-b border-[var(--color-border)] bg-white/[0.02] text-[11px] uppercase tracking-wide text-[var(--color-text-disabled)]">
          <tr>
            <th className="px-4 py-3">Source</th>
            <th className="w-[120px] px-4 py-3">State</th>
            <th className="w-[120px] px-4 py-3">Sensitivity</th>
            <th className="w-[220px] px-4 py-3">Tags</th>
            <th className="w-[140px] px-4 py-3">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)] text-[13px]">
          {sourceCards.map((card) => (
            <tr
              key={card.id}
              className="cursor-pointer bg-transparent transition-colors hover:bg-white/[0.03]"
              onClick={() => onOpen(card.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpen(card.id)
                }
              }}
              tabIndex={0}
            >
              <td className="px-4 py-3 align-top">
                <div className="font-medium text-[var(--color-text-primary)]">{card.title}</div>
                <div className="mt-1 truncate font-mono text-[11px] text-[var(--color-text-disabled)]">
                  {card.id}
                </div>
                <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-[var(--color-text-muted)]">
                  {sourceSummary(card)}
                </div>
              </td>
              <td className="px-4 py-3 align-top">
                <div className="space-y-1">
                  <SourceStateBadge state={card.state} />
                  <ReadinessBadge card={card} />
                </div>
              </td>
              <td className="px-4 py-3 align-top text-[var(--color-text-secondary)]">
                {card.sensitivity}
              </td>
              <td className="px-4 py-3 align-top">
                <TagList tags={card.tags ?? []} compact />
              </td>
              <td className="px-4 py-3 align-top text-[12px] text-[var(--color-text-muted)]">
                {updatedLabel(card)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function SourceCardsPage() {
  const navigate = useNavigate()
  const [sourceCards, setSourceCards] = useState<SourceCardPublicView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [sensitivityFilter, setSensitivityFilter] = useState<SensitivityFilter>('all')

  const loadSourceCards = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<SourceCardListResponse>('/api/source-cards')
      setSourceCards(res.sourceCards)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Source Cards')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSourceCards()
    const handleSourceCardsChanged = () => {
      void loadSourceCards()
    }
    window.addEventListener(SOURCE_CARDS_CHANGED_EVENT, handleSourceCardsChanged)
    return () => window.removeEventListener(SOURCE_CARDS_CHANGED_EVENT, handleSourceCardsChanged)
  }, [loadSourceCards])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return sourceCards
      .filter((card) => stateFilter === 'all' || card.state === stateFilter)
      .filter((card) => sensitivityFilter === 'all' || card.sensitivity === sensitivityFilter)
      .filter((card) => {
        if (!q) return true
        return [
          card.id,
          card.title,
          card.sensitivity,
          sourceSummary(card),
          card.sourceDoc.body,
          ...(card.tags ?? []),
        ]
          .join('\n')
          .toLowerCase()
          .includes(q)
      })
  }, [search, sensitivityFilter, sourceCards, stateFilter])

  return (
    <div className="mx-auto max-w-[1200px] p-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight">Source Cards</h1>
          <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
            Small Markdown guides for reusable data sources. The list starts empty.
          </p>
        </div>
        <div className="relative w-full sm:w-[320px]">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-disabled)]"
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="input-field w-full pl-9"
            placeholder="Search source docs..."
          />
        </div>
      </div>

      <div className="mb-4 space-y-3 rounded-lg border border-[var(--color-border)] bg-white/[0.02] p-3">
        <FilterRow values={STATE_FILTERS} selected={stateFilter} onClick={setStateFilter} />
        <FilterRow
          values={SENSITIVITY_FILTERS}
          selected={sensitivityFilter}
          onClick={setSensitivityFilter}
        />
        <div className="flex flex-wrap gap-2 text-[11px] text-[var(--color-text-muted)]">
          <span>{sourceCards.length} total</span>
          <span>{sourceCards.filter((card) => card.state === 'draft').length} draft</span>
          <span>{sourceCards.filter((card) => card.state === 'active').length} active</span>
          <span>{sourceCards.filter((card) => card.state === 'retired').length} retired</span>
        </div>
      </div>

      {loading ? (
        <SourceCardTableSkeleton />
      ) : error ? (
        <SourceCardError message={error} />
      ) : sourceCards.length === 0 ? (
        <SourceCardEmpty />
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-[var(--color-border)] p-8 text-center text-[13px] text-[var(--color-text-muted)]">
          No Source Cards match the current filters.
        </div>
      ) : (
        <SourceCardTableView
          sourceCards={filtered}
          onOpen={(id) => navigate({ to: '/source-cards/$id', params: { id } })}
        />
      )}
    </div>
  )
}

function FilterRow<T extends string>({
  values,
  selected,
  onClick,
}: {
  values: T[]
  selected: T
  onClick: (value: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <FilterButton key={value} value={value} selected={selected === value} onClick={onClick} />
      ))}
    </div>
  )
}

function FilterButton<T extends string>({
  value,
  selected,
  onClick,
}: {
  value: T
  selected: boolean
  onClick: (value: T) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
        selected
          ? 'bg-[var(--color-accent)] text-black'
          : 'bg-white/[0.04] text-[var(--color-text-muted)] hover:bg-white/[0.08] hover:text-[var(--color-text-primary)]'
      }`}
    >
      {formatLabel(value)}
    </button>
  )
}

function SourceCardTableSkeleton() {
  return (
    <div className="space-y-2 rounded-lg border border-[var(--color-border)] p-4">
      {Array.from({ length: 5 }, (_, index) => `source-card-loading-${index}`).map((key) => (
        <div key={key} className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3 py-2">
          <Skeleton className="h-4" />
          <Skeleton className="h-4" />
          <Skeleton className="h-4" />
          <Skeleton className="h-4" />
        </div>
      ))}
    </div>
  )
}

function SourceCardError({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-400/30 bg-red-400/[0.05] p-5">
      <h2 className="text-[14px] font-semibold text-red-400">Unable to load Source Cards</h2>
      <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">{message}</p>
    </div>
  )
}

function SourceCardEmpty() {
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-8 text-center">
      <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">
        No Source Cards yet
      </h2>
      <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">
        Generate a draft from an existing session, review the Markdown guide, then activate it.
      </p>
    </div>
  )
}

export function SourceCardDetailPage() {
  const navigate = useNavigate()
  const params = useParams({ strict: false }) as { id?: string }
  const id = params.id
  const [card, setCard] = useState<SourceCardPublicView | null>(null)
  const [loading, setLoading] = useState(true)
  const [mutationBusy, setMutationBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSourceCard = useCallback(
    async (showLoading = true) => {
      if (!id) {
        setError('Source Card id is required')
        setLoading(false)
        return
      }

      if (showLoading) setLoading(true)
      try {
        const res = await apiFetch<{ sourceCard: SourceCardPublicView }>(
          `/api/source-cards/${encodeURIComponent(id)}`,
        )
        setCard(res.sourceCard)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load Source Card')
      } finally {
        if (showLoading) setLoading(false)
      }
    },
    [id],
  )

  useEffect(() => {
    void loadSourceCard()
  }, [loadSourceCard])

  async function activateSourceCard(payload: SourceCardActivationPayload) {
    if (!id) return
    setMutationBusy(true)
    try {
      const res = await apiPost<{ sourceCard: SourceCardPublicView }>(
        `/api/source-cards/${encodeURIComponent(id)}/activate`,
        payload,
      )
      setCard(res.sourceCard)
      await loadSourceCard(false)
      emitSourceCardsChanged()
    } finally {
      setMutationBusy(false)
    }
  }

  async function retireSourceCard(reason: string) {
    if (!id) return
    setMutationBusy(true)
    try {
      const res = await apiPost<{ sourceCard: SourceCardPublicView }>(
        `/api/source-cards/${encodeURIComponent(id)}/retire`,
        { reason },
      )
      setCard(res.sourceCard)
      await loadSourceCard(false)
      emitSourceCardsChanged()
    } finally {
      setMutationBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-[1200px] p-6">
        <SourceCardTableSkeleton />
      </div>
    )
  }

  if (error || !card) {
    return (
      <div className="mx-auto max-w-[1200px] p-6">
        <BackButton onClick={() => navigate({ to: '/source-cards' })} />
        <SourceCardError message={error ?? 'Source Card not found'} />
      </div>
    )
  }

  return (
    <SourceCardDetailView
      card={card}
      onBack={() => navigate({ to: '/source-cards' })}
      onActivate={activateSourceCard}
      onRetire={retireSourceCard}
      mutationBusy={mutationBusy}
    />
  )
}

function emitSourceCardsChanged() {
  window.dispatchEvent(new CustomEvent(SOURCE_CARDS_CHANGED_EVENT))
}

export function SourceCardDetailView({
  card,
  onBack,
  onActivate,
  onRetire,
  mutationBusy = false,
}: {
  card: SourceCardPublicView
  onBack?: () => void
  onActivate?: (payload: SourceCardActivationPayload) => Promise<void> | void
  onRetire?: (reason: string) => Promise<void> | void
  mutationBusy?: boolean
}) {
  const [dialog, setDialog] = useState<'activate' | 'retire' | null>(null)
  const readiness = getSourceCardReadiness(card)

  return (
    <div className="mx-auto max-w-[1200px] p-6">
      <BackButton onClick={onBack} />

      <div className="mb-4 border-b border-[var(--color-border)] pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-bold tracking-tight">{card.title}</h1>
            <p className="mt-1 font-mono text-[12px] text-[var(--color-text-disabled)]">
              {card.id}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <SourceStateBadge state={card.state} />
            <ReadinessBadge card={card} />
            <span className="rounded bg-white/[0.04] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
              {card.sensitivity}
            </span>
          </div>
        </div>
        <p className="mt-3 max-w-[900px] text-[13px] leading-6 text-[var(--color-text-secondary)]">
          {sourceSummary(card)}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_340px]">
        <div className="space-y-4">
          <DetailSection title="Source Doc">
            <pre className="max-h-[620px] overflow-auto whitespace-pre-wrap rounded border border-[var(--color-border)] bg-black/20 p-4 text-[12px] leading-6 text-[var(--color-text-secondary)]">
              {card.sourceDoc.body}
            </pre>
          </DetailSection>

          <DetailSection title="Source Evidence">
            <KeyValueGrid
              rows={[
                ['Session', card.source?.sessionId ?? 'Not recorded'],
                ['Summary', card.source?.summary ?? 'Not recorded'],
                ['Trace refs', joinRefs(card.source?.traceRefs)],
                ['Artifact refs', joinRefs(card.source?.artifactRefs)],
              ]}
            />
          </DetailSection>
        </div>

        <aside className="space-y-4">
          <DetailSection title="Review">
            <p className="text-[13px] leading-6 text-[var(--color-text-secondary)]">
              {readiness.detail}
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={card.state !== 'draft' || mutationBusy || !onActivate}
                onClick={() => setDialog('activate')}
                className="btn-primary inline-flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckCircle size={15} />
                Activate
              </button>
              <button
                type="button"
                disabled={card.state === 'retired' || mutationBusy || !onRetire}
                onClick={() => setDialog('retire')}
                className="btn-secondary disabled:cursor-not-allowed disabled:opacity-50"
              >
                Retire
              </button>
            </div>
          </DetailSection>

          <DetailSection title="Metadata">
            <KeyValueGrid
              rows={[
                ['State', card.state],
                ['Sensitivity', card.sensitivity],
                ['Created', card.createdAt ?? 'Not recorded'],
                ['Updated', card.updatedAt ?? 'Not recorded'],
              ]}
            />
            <div className="mt-4">
              <div className="mb-2 text-[11px] uppercase tracking-wide text-[var(--color-text-disabled)]">
                Tags
              </div>
              <TagList tags={card.tags ?? []} />
            </div>
          </DetailSection>
        </aside>
      </div>

      <ActivateSourceDialog
        card={card}
        open={dialog === 'activate'}
        onClose={() => setDialog(null)}
        onSubmit={async (payload) => {
          await onActivate?.(payload)
          setDialog(null)
        }}
      />
      <RetireSourceDialog
        card={card}
        open={dialog === 'retire'}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          await onRetire?.(reason)
          setDialog(null)
        }}
      />
    </div>
  )
}

function BackButton({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-4 inline-flex items-center gap-2 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
    >
      <ArrowLeft size={14} />
      Back to Source Cards
    </button>
  )
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-white/[0.015] p-4">
      <h2 className="mb-3 text-[13px] font-semibold text-[var(--color-text-primary)]">{title}</h2>
      {children}
    </section>
  )
}

function KeyValueGrid({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
      {rows.map(([key, value]) => (
        <div key={key} className="min-w-0">
          <dt className="mb-1 uppercase tracking-wide text-[var(--color-text-disabled)]">{key}</dt>
          <dd className="break-words text-[var(--color-text-secondary)]">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function TagList({ tags, compact = false }: { tags: string[]; compact?: boolean }) {
  if (tags.length === 0) {
    return <span className="text-[12px] text-[var(--color-text-disabled)]">No tags</span>
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className={`rounded bg-white/[0.04] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] ${
            compact ? 'max-w-[96px] truncate' : ''
          }`}
        >
          {tag}
        </span>
      ))}
    </div>
  )
}

function joinRefs(refs: string[] | undefined): string {
  return refs && refs.length > 0 ? refs.join(', ') : 'Not recorded'
}

function DialogFrame({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-[520px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-[16px] font-semibold text-[var(--color-text-primary)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded hover:bg-white/[0.06]"
            aria-label={`Close ${title}`}
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function ActivateSourceDialog({
  card,
  open,
  onClose,
  onSubmit,
}: {
  card: SourceCardPublicView
  open: boolean
  onClose: () => void
  onSubmit: (payload: SourceCardActivationPayload) => Promise<void> | void
}) {
  const [reason, setReason] = useState('')
  const trimmed = reason.trim()

  return (
    <DialogFrame open={open} title="Activate Source Card" onClose={onClose}>
      <p className="mb-4 text-[13px] leading-6 text-[var(--color-text-secondary)]">
        Activate {card.title} only after the Markdown sourceDoc is accurate enough to guide future
        tool use.
      </p>
      <label className="block text-[12px] font-medium text-[var(--color-text-muted)]">
        Activation reason
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="input-field mt-2 min-h-[96px] w-full resize-y"
          placeholder="What was reviewed?"
        />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!trimmed}
          onClick={() => onSubmit({ reason: trimmed })}
        >
          Activate
        </button>
      </div>
    </DialogFrame>
  )
}

export function RetireSourceDialog({
  card,
  open,
  onClose,
  onSubmit,
}: {
  card: SourceCardPublicView
  open: boolean
  onClose: () => void
  onSubmit: (reason: string) => Promise<void> | void
}) {
  const [reason, setReason] = useState('')
  const trimmed = reason.trim()

  return (
    <DialogFrame open={open} title="Retire Source Card" onClose={onClose}>
      <p className="mb-4 text-[13px] leading-6 text-[var(--color-text-secondary)]">
        Retiring {card.title} keeps the document for history but removes it from new preflight use.
      </p>
      <label className="block text-[12px] font-medium text-[var(--color-text-muted)]">
        Retire reason
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="input-field mt-2 min-h-[96px] w-full resize-y"
          placeholder="Why should future requests avoid this card?"
        />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="rounded bg-red-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!trimmed}
          onClick={() => onSubmit(trimmed)}
        >
          Retire
        </button>
      </div>
    </DialogFrame>
  )
}
