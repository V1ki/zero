import { ArrowLeft, CheckCircle, MagnifyingGlass, X } from '@phosphor-icons/react'
import { useNavigate, useParams } from '@tanstack/react-router'
import type {
  SourceCard,
  SourceCardAdapterMode,
  SourceCardCredential,
  SourceCardState,
} from '@zero-os/shared'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Skeleton } from '../components/shared/Skeleton'
import { apiFetch, apiPost } from '../lib/api'
import { formatTimeAgo } from '../lib/format'

export type SourceCardPublicView = Omit<SourceCard, 'credentials' | 'adapter' | 'health'> & {
  adapter: SourceCardPublicAdapter
  health: SourceCardPublicHealth
  credentialBindings: SourceCredentialBindingView[]
}

export interface SourceCardPublicAdapter {
  mode: SourceCard['adapter']['mode']
  activeRevision: string
  revisions: SourceCardPublicAdapterRevision[]
}

export interface SourceCardPublicAdapterRevision {
  id: string
  status: SourceCard['adapter']['revisions'][number]['status']
  mode: SourceCard['adapter']['revisions'][number]['mode']
  entrypointSummary: string
  parser: SourceCard['adapter']['revisions'][number]['parser']
  timeoutMs: number
  rateLimit?: SourceCard['adapter']['revisions'][number]['rateLimit']
  templateCounts: {
    commands: number
    endpoints: number
    samples: number
  }
}

export interface SourceCardPublicEvidence {
  sourceCardId?: string
  capabilityId?: string
  adapterRevision?: string
  commandTemplateHash?: string
  endpointTemplateHash?: string
  statusCode?: number
  exitCode?: number
  durationMs?: number
  rowCount?: number
  schemaKeys?: string[]
  artifactRefs?: string[]
  failureClass?: string
}

export type SourceCardPublicHealth = Omit<SourceCard['health'], 'lastResult'> & {
  lastResult?: Omit<NonNullable<SourceCard['health']['lastResult']>, 'evidence'> & {
    evidence: SourceCardPublicEvidence
  }
}

export interface SourceCredentialBindingView {
  id: string
  required: boolean
  bindingType: SourceCardCredential['binding']['type']
  injectAs: SourceCardCredential['injectAs']
  scopes: string[]
  hasReference: boolean
}

export interface SourceCardPromotePayload {
  reason: string
  reviewedCapabilityIds: string[]
  privateScopeConfirmation?: {
    metadataOnly: boolean
    bodyAccessApproved: false
    attachmentAccessApproved: false
  }
}

interface SourceCardListResponse {
  sourceCards: SourceCardPublicView[]
}

export interface SourceObservationSummaryRow {
  id?: string
  sourceCardId: string
  capabilityId: string
  observedAt: string
  kind: 'data' | 'health_check' | 'schema_sample' | 'error'
  cursor?: string | { type: 'object'; keys: string[] }
  evidence?: SourceCardPublicEvidence
}

export interface SourceObservationSummaryResponse {
  sourceCardId: string
  summaryOnly: true
  summary: {
    total: number
    kindCounts: Record<string, number>
    capabilityIds: string[]
    lastObservedAt?: string
    latestFailureClass?: string
  }
  observations: SourceObservationSummaryRow[]
}

type StateFilter = 'all' | SourceCardState
type AdapterFilter = 'all' | SourceCardAdapterMode
type SensitivityFilter = 'all' | SourceCard['sensitivity']

const STATE_FILTERS: StateFilter[] = [
  'all',
  'candidate',
  'verified',
  'active',
  'degraded',
  'broken',
  'retired',
]
const ADAPTER_FILTERS: AdapterFilter[] = ['all', 'cli', 'api', 'browser', 'direct']
const SENSITIVITY_FILTERS: SensitivityFilter[] = [
  'all',
  'public',
  'internal',
  'private',
  'restricted',
]
const LIFECYCLE: SourceCardState[] = [
  'discovered',
  'candidate',
  'verified',
  'active',
  'degraded',
  'broken',
  'retired',
]
const SOURCE_CARDS_CHANGED_EVENT = 'zero:source-cards:changed'

const STATE_STYLES: Record<SourceCardState, { dot: string; text: string; bg: string }> = {
  discovered: { dot: 'bg-slate-500', text: 'text-slate-400', bg: 'bg-slate-400/10' },
  candidate: { dot: 'bg-amber-400', text: 'text-amber-400', bg: 'bg-amber-400/10' },
  verified: { dot: 'bg-cyan-400', text: 'text-cyan-400', bg: 'bg-cyan-400/10' },
  active: { dot: 'bg-emerald-400', text: 'text-emerald-400', bg: 'bg-emerald-400/10' },
  degraded: { dot: 'bg-amber-400', text: 'text-amber-400', bg: 'bg-amber-400/10' },
  broken: { dot: 'bg-red-400', text: 'text-red-400', bg: 'bg-red-400/10' },
  retired: { dot: 'bg-slate-600', text: 'text-slate-500', bg: 'bg-slate-400/10' },
}

type WatchTone = 'allowed' | 'blocked' | 'pending' | 'retired'

const WATCH_STYLES: Record<WatchTone, string> = {
  allowed: 'bg-emerald-400/10 text-emerald-400',
  blocked: 'bg-red-400/10 text-red-400',
  pending: 'bg-amber-400/10 text-amber-400',
  retired: 'bg-slate-400/10 text-slate-500',
}

export function getWatchEligibility(card: SourceCardPublicView): {
  label: string
  tone: WatchTone
  detail: string
} {
  if (card.state === 'retired') {
    return { label: 'Retired', tone: 'retired', detail: 'Retired sources cannot be watched.' }
  }
  if (card.state === 'broken') {
    return {
      label: 'Blocked',
      tone: 'blocked',
      detail: 'Broken health or auth state blocks watch.',
    }
  }
  if (card.state === 'degraded') {
    return {
      label: 'Health review',
      tone: 'pending',
      detail: 'Resolve degraded health before new watches.',
    }
  }
  if (card.state !== 'active') {
    return {
      label: card.state === 'candidate' ? 'Needs verification' : 'Needs activation',
      tone: 'pending',
      detail: 'Only active Source Cards can be consumed by Watch.',
    }
  }
  if (!card.capabilities.some((capability) => capability.watchable)) {
    return {
      label: 'No watchable capability',
      tone: 'blocked',
      detail: 'No capability is marked watchable.',
    }
  }
  return {
    label: 'Allowed',
    tone: 'allowed',
    detail: 'Watch may reference sourceCardId and capability only.',
  }
}

function formatLabel(value: string): string {
  return value.replaceAll('_', ' ')
}

function activeRevision(card: SourceCardPublicView) {
  return (
    card.adapter.revisions.find((revision) => revision.id === card.adapter.activeRevision) ??
    card.adapter.revisions[0]
  )
}

function healthLabel(card: SourceCardPublicView): string {
  if (card.health.lastStatus) return card.health.lastStatus
  return 'unknown'
}

function updatedLabel(card: SourceCardPublicView): string {
  const ts = card.updatedAt ?? card.createdAt ?? card.discovery.firstSeenAt
  return ts ? formatTimeAgo(ts) : 'not stamped'
}

function isPrivateSource(card: SourceCardPublicView): boolean {
  return card.sensitivity === 'private' || card.sensitivity === 'restricted'
}

function isMarketSource(card: SourceCardPublicView): boolean {
  return card.kind === 'public_market_data'
}

export function SourceStateBadge({ state }: { state: SourceCardState }) {
  const style = STATE_STYLES[state]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] ${style.bg} ${style.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {state}
    </span>
  )
}

export function WatchEligibilityBadge({ card }: { card: SourceCardPublicView }) {
  const watch = getWatchEligibility(card)
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-[11px] ${WATCH_STYLES[watch.tone]}`}>
      {watch.label}
    </span>
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
      className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
        selected
          ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
      }`}
    >
      {value === 'all' ? 'All' : formatLabel(value)}
    </button>
  )
}

function StatusStrip({ sourceCards }: { sourceCards: SourceCardPublicView[] }) {
  const activeWatchReady = sourceCards.filter(
    (card) => getWatchEligibility(card).tone === 'allowed',
  ).length
  const needReview = sourceCards.filter((card) =>
    ['candidate', 'verified'].includes(card.state),
  ).length
  const degraded = sourceCards.filter((card) => card.state === 'degraded').length
  const broken = sourceCards.filter((card) => card.state === 'broken').length
  const privateBlocked = sourceCards.filter(
    (card) => isPrivateSource(card) && getWatchEligibility(card).tone !== 'allowed',
  ).length

  return (
    <div className="flex gap-4 overflow-x-auto border-y border-[var(--color-border)] py-2 text-[12px]">
      <StatusCount label="Active watch-ready" value={activeWatchReady} />
      <StatusCount label="Need review" value={needReview} />
      <StatusCount label="Degraded" value={degraded} />
      <StatusCount label="Broken" value={broken} />
      <StatusCount label="Private scope blocked" value={privateBlocked} />
    </div>
  )
}

function StatusCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="font-mono text-[var(--color-text-primary)]">{value}</span>
      <span className="text-[var(--color-text-muted)]">{label}</span>
    </div>
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
    <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-white/[0.02]">
      <table className="w-full min-w-[980px] border-collapse text-left">
        <thead className="border-b border-[var(--color-border)] text-[11px] uppercase tracking-wide text-[var(--color-text-disabled)]">
          <tr>
            <th className="px-4 py-3 font-semibold">Source</th>
            <th className="px-3 py-3 font-semibold">State</th>
            <th className="px-3 py-3 font-semibold">Kind</th>
            <th className="px-3 py-3 font-semibold">Sensitivity</th>
            <th className="px-3 py-3 font-semibold">Adapter</th>
            <th className="px-3 py-3 font-semibold">Health</th>
            <th className="px-3 py-3 font-semibold">Watch</th>
            <th className="px-3 py-3 font-semibold">Updated</th>
          </tr>
        </thead>
        <tbody>
          {sourceCards.map((card) => {
            const revision = activeRevision(card)
            return (
              <tr
                key={card.id}
                className="border-b border-[var(--color-border)] transition-colors last:border-0 hover:bg-white/[0.035]"
              >
                <td className="max-w-[320px] px-4 py-3">
                  <button
                    type="button"
                    onClick={() => onOpen(card.id)}
                    className="block w-full rounded text-left focus:bg-[var(--color-accent-glow)] focus:outline-none"
                  >
                    <span className="block text-[13px] font-medium text-[var(--color-text-primary)]">
                      {card.title}
                    </span>
                    <span className="mt-0.5 block font-mono text-[11px] text-[var(--color-text-disabled)]">
                      {card.id}
                    </span>
                    <span className="mt-1 block truncate text-[11px] text-[var(--color-text-muted)]">
                      {card.discovery.learnedMethodSummary}
                    </span>
                  </button>
                </td>
                <td className="px-3 py-3">
                  <SourceStateBadge state={card.state} />
                </td>
                <td className="px-3 py-3 text-[12px] text-[var(--color-text-secondary)]">
                  {formatLabel(card.kind)}
                </td>
                <td className="px-3 py-3 text-[12px] text-[var(--color-text-secondary)]">
                  {card.sensitivity}
                </td>
                <td className="px-3 py-3">
                  <div className="text-[12px] text-[var(--color-text-primary)]">
                    {card.adapter.mode}
                  </div>
                  <div className="font-mono text-[10px] text-[var(--color-text-disabled)]">
                    {revision?.id ?? card.adapter.activeRevision}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <div className="text-[12px] text-[var(--color-text-secondary)]">
                    {healthLabel(card)}
                  </div>
                  {card.health.failureClass && (
                    <div className="mt-0.5 text-[10px] text-amber-400">
                      {card.health.failureClass}
                    </div>
                  )}
                </td>
                <td className="px-3 py-3">
                  <WatchEligibilityBadge card={card} />
                </td>
                <td className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">
                  {updatedLabel(card)}
                </td>
              </tr>
            )
          })}
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
  const [adapterFilter, setAdapterFilter] = useState<AdapterFilter>('all')
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
      .filter((card) => adapterFilter === 'all' || card.adapter.mode === adapterFilter)
      .filter((card) => sensitivityFilter === 'all' || card.sensitivity === sensitivityFilter)
      .filter(
        (card) =>
          !q ||
          card.id.toLowerCase().includes(q) ||
          card.title.toLowerCase().includes(q) ||
          card.kind.toLowerCase().includes(q) ||
          card.discovery.learnedMethodSummary.toLowerCase().includes(q),
      )
  }, [adapterFilter, search, sensitivityFilter, sourceCards, stateFilter])

  return (
    <div className="mx-auto max-w-[1400px] p-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight">Source Cards</h1>
          <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
            Persistent data-source capabilities. Watches can only reference active watchable
            capabilities.
          </p>
        </div>
        <div className="relative w-full sm:w-[300px]">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-disabled)]"
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="input-field w-full pl-9"
            placeholder="Search sources..."
          />
        </div>
      </div>

      <div className="mb-4 space-y-3 rounded-lg border border-[var(--color-border)] bg-white/[0.02] p-3">
        <div className="flex flex-wrap gap-1.5">
          {STATE_FILTERS.map((state) => (
            <FilterButton
              key={state}
              value={state}
              selected={stateFilter === state}
              onClick={setStateFilter}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {ADAPTER_FILTERS.map((adapter) => (
            <FilterButton
              key={adapter}
              value={adapter}
              selected={adapterFilter === adapter}
              onClick={setAdapterFilter}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SENSITIVITY_FILTERS.map((sensitivity) => (
            <FilterButton
              key={sensitivity}
              value={sensitivity}
              selected={sensitivityFilter === sensitivity}
              onClick={setSensitivityFilter}
            />
          ))}
        </div>
        <StatusStrip sourceCards={sourceCards} />
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

function SourceCardTableSkeleton() {
  return (
    <div className="space-y-2 rounded-lg border border-[var(--color-border)] p-4">
      {Array.from({ length: 6 }, (_, index) => `source-card-loading-${index}`).map((key) => (
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
        Data sources become candidates after Zero discovers a reusable, safe retrieval method.
      </p>
    </div>
  )
}

export function SourceCardDetailPage() {
  const navigate = useNavigate()
  const params = useParams({ strict: false }) as { id?: string }
  const id = params.id
  const [card, setCard] = useState<SourceCardPublicView | null>(null)
  const [summary, setSummary] = useState<SourceObservationSummaryResponse | null>(null)
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
        const [cardRes, summaryRes] = await Promise.all([
          apiFetch<{ sourceCard: SourceCardPublicView }>(
            `/api/source-cards/${encodeURIComponent(id)}`,
          ),
          apiFetch<SourceObservationSummaryResponse>(
            `/api/source-cards/${encodeURIComponent(id)}/observations?summary=1`,
          ),
        ])
        setCard(cardRes.sourceCard)
        setSummary(summaryRes)
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

  async function promoteSourceCard(payload: SourceCardPromotePayload) {
    if (!id) {
      return
    }
    setMutationBusy(true)
    try {
      const res = await apiPost<{ sourceCard: SourceCardPublicView }>(
        `/api/source-cards/${encodeURIComponent(id)}/promote`,
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
    if (!id) {
      return
    }
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
      <div className="mx-auto max-w-[1400px] p-6">
        <SourceCardTableSkeleton />
      </div>
    )
  }

  if (error || !card) {
    return (
      <div className="mx-auto max-w-[1400px] p-6">
        <button
          type="button"
          onClick={() => navigate({ to: '/source-cards' })}
          className="mb-4 inline-flex items-center gap-2 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
        >
          <ArrowLeft size={14} />
          Back to Source Cards
        </button>
        <SourceCardError message={error ?? 'Source Card not found'} />
      </div>
    )
  }

  return (
    <SourceCardDetailView
      card={card}
      observationSummary={summary}
      onBack={() => navigate({ to: '/source-cards' })}
      onPromote={promoteSourceCard}
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
  observationSummary,
  onBack,
  onPromote,
  onRetire,
  mutationBusy = false,
}: {
  card: SourceCardPublicView
  observationSummary: SourceObservationSummaryResponse | null
  onBack?: () => void
  onPromote?: (payload: SourceCardPromotePayload) => Promise<void> | void
  onRetire?: (reason: string) => Promise<void> | void
  mutationBusy?: boolean
}) {
  const revision = activeRevision(card)
  const watch = getWatchEligibility(card)
  const [reviewPanel, setReviewPanel] = useState<'promote' | 'retire' | null>(null)

  return (
    <div className="mx-auto max-w-[1400px] p-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-2 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
      >
        <ArrowLeft size={14} />
        Back to Source Cards
      </button>

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
            <span className="rounded bg-white/[0.04] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
              {formatLabel(card.kind)}
            </span>
            <span className="rounded bg-white/[0.04] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
              {card.sensitivity}
            </span>
            <WatchEligibilityBadge card={card} />
          </div>
        </div>
        <p className="mt-3 max-w-[900px] text-[13px] leading-6 text-[var(--color-text-secondary)]">
          {card.discovery.learnedMethodSummary}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_360px]">
        <div className="space-y-4">
          <DetailSection title="Identity">
            <KeyValueGrid
              rows={[
                ['Owner', card.owner.scope],
                ['First seen', card.discovery.firstSeenAt],
                ['Session', card.discovery.discoveredFrom.sessionId],
                ['Trace refs', card.discovery.discoveredFrom.traceRefs.join(', ')],
                [
                  'Artifact refs',
                  card.discovery.discoveredFrom.artifactRefs?.join(', ') || 'None recorded',
                ],
              ]}
            />
          </DetailSection>

          <DetailSection title="Lifecycle">
            <div className="flex flex-wrap gap-2">
              {LIFECYCLE.map((state) => {
                const active = card.state === state
                return (
                  <span
                    key={state}
                    className={`rounded px-2 py-1 text-[11px] ${
                      active
                        ? `${STATE_STYLES[state].bg} ${STATE_STYLES[state].text}`
                        : 'bg-white/[0.03] text-[var(--color-text-muted)]'
                    }`}
                  >
                    {state}
                  </span>
                )
              })}
            </div>
            <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">
              This read-only view does not promote, retire, or run health probes.
            </p>
          </DetailSection>

          <DetailSection title="Capabilities">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-[12px]">
                <thead className="text-[11px] uppercase tracking-wide text-[var(--color-text-disabled)]">
                  <tr>
                    <th className="border-b border-[var(--color-border)] py-2 pr-3">Capability</th>
                    <th className="border-b border-[var(--color-border)] py-2 pr-3">Operation</th>
                    <th className="border-b border-[var(--color-border)] py-2 pr-3">Watchable</th>
                    <th className="border-b border-[var(--color-border)] py-2 pr-3">Privacy</th>
                    <th className="border-b border-[var(--color-border)] py-2 pr-3">Allowed</th>
                    <th className="border-b border-[var(--color-border)] py-2 pr-3">Prohibited</th>
                  </tr>
                </thead>
                <tbody>
                  {card.capabilities.map((capability) => (
                    <tr
                      key={capability.id}
                      className="border-b border-[var(--color-border)] last:border-0"
                    >
                      <td className="py-3 pr-3 font-mono text-[var(--color-text-primary)]">
                        {capability.id}
                      </td>
                      <td className="py-3 pr-3 text-[var(--color-text-secondary)]">
                        {capability.operation}
                      </td>
                      <td className="py-3 pr-3 text-[var(--color-text-secondary)]">
                        {capability.watchable ? 'Yes' : 'No'}
                      </td>
                      <td className="py-3 pr-3 text-[var(--color-text-secondary)]">
                        {capability.defaultPrivacyScope}
                      </td>
                      <td className="py-3 pr-3 text-[var(--color-text-secondary)]">
                        {capability.allowedActions.join(', ') || 'None'}
                      </td>
                      <td className="py-3 pr-3 text-[var(--color-text-secondary)]">
                        {capability.prohibitedActions.join(', ') || 'None'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </DetailSection>

          <DetailSection title="Adapter Revision">
            <KeyValueGrid
              rows={[
                ['Mode', card.adapter.mode],
                ['Active revision', card.adapter.activeRevision],
                ['Revision status', revision?.status ?? 'unknown'],
                ['Entrypoint', revision?.entrypointSummary ?? 'unknown'],
                ['Parser', revision?.parser.type ?? 'unknown'],
                ['Schema keys', revision?.parser.schemaKeys.join(', ') ?? 'None'],
                ['Timeout', revision ? `${revision.timeoutMs}ms` : 'unknown'],
                [
                  'Rate limit',
                  revision?.rateLimit
                    ? `${revision.rateLimit.minIntervalMs}ms min interval`
                    : 'None declared',
                ],
                [
                  'Template counts',
                  revision
                    ? `${revision.templateCounts.commands} command, ${revision.templateCounts.endpoints} endpoint, ${revision.templateCounts.samples} sample`
                    : 'None',
                ],
              ]}
            />
            <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">
              Command and endpoint templates are not expanded in the UI. Only entrypoint, parser,
              and schema metadata are shown.
            </p>
          </DetailSection>

          <DetailSection title="Privacy Policy">
            <KeyValueGrid
              rows={[
                ['Data classes', card.privacy.dataClasses.join(', ')],
                ['Body policy', card.privacy.bodyPolicy],
                ['Attachment policy', card.privacy.attachmentPolicy],
                ['Card retention', card.privacy.retention.card],
                ['Observation retention', card.privacy.retention.observations],
                ['Artifact retention', card.privacy.retention.artifacts],
              ]}
            />
          </DetailSection>

          <DetailSection title="Health Checks">
            <div className="space-y-3">
              {card.health.checks.map((check) => (
                <div
                  key={check.id}
                  className="border-b border-[var(--color-border)] pb-3 last:border-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12px] text-[var(--color-text-primary)]">
                      {check.id}
                    </span>
                    <span className="rounded bg-white/[0.04] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                      {check.cadence}
                    </span>
                  </div>
                  <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">
                    {check.method}
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    Success: {check.successCriteria}
                  </p>
                </div>
              ))}
              <KeyValueGrid
                rows={[
                  ['Last status', healthLabel(card)],
                  ['Last checked', card.health.lastCheckedAt ?? 'Never'],
                  ['Failure class', card.health.failureClass ?? 'None'],
                ]}
              />
            </div>
          </DetailSection>

          <ObservationSummaryPanel summary={observationSummary} />
        </div>

        <aside className="space-y-4">
          <div className="card p-4">
            <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">Approval</h2>
            <p className="mt-2 text-[12px] leading-5 text-[var(--color-text-muted)]">
              {watch.detail}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <WatchEligibilityBadge card={card} />
              <SourceStateBadge state={card.state} />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setReviewPanel('promote')}
                disabled={!onPromote || !canOpenPromote(card)}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-[var(--color-accent)] px-3 py-2 text-[12px] font-medium text-black disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-[var(--color-text-disabled)]"
              >
                <CheckCircle size={14} />
                Promote
              </button>
              <button
                type="button"
                onClick={() => setReviewPanel('retire')}
                disabled={!onRetire || card.state === 'retired'}
                className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-[12px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:text-[var(--color-text-disabled)]"
              >
                <X size={14} />
                Retire
              </button>
            </div>
          </div>

          <div className="card p-4">
            <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">
              Credential Bindings
            </h2>
            <div className="mt-3 space-y-3">
              {card.credentialBindings.map((binding) => (
                <div
                  key={binding.id}
                  className="border-b border-[var(--color-border)] pb-3 last:border-0 last:pb-0"
                >
                  <div className="font-mono text-[12px] text-[var(--color-text-primary)]">
                    {binding.id}
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
                    {binding.bindingType} · {binding.injectAs}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    {binding.required ? 'Required' : 'Optional'} ·{' '}
                    {binding.hasReference ? 'configured reference present' : 'no reference needed'}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    Scopes: {binding.scopes.join(', ') || 'none'}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-4">
            <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">
              Safety Boundary
            </h2>
            <SafetyBoundary card={card} />
          </div>
        </aside>
      </div>

      <PromoteSourceDrawer
        card={card}
        open={reviewPanel === 'promote'}
        busy={mutationBusy}
        onClose={() => setReviewPanel(null)}
        onSubmit={async (payload) => {
          if (!onPromote) return
          await onPromote(payload)
          setReviewPanel(null)
        }}
      />
      <RetireSourceDialog
        card={card}
        open={reviewPanel === 'retire'}
        busy={mutationBusy}
        onClose={() => setReviewPanel(null)}
        onSubmit={async (reason) => {
          if (!onRetire) return
          await onRetire(reason)
          setReviewPanel(null)
        }}
      />
    </div>
  )
}

function canOpenPromote(card: SourceCardPublicView): boolean {
  return card.state === 'verified' || card.state === 'degraded'
}

export function PromoteSourceDrawer({
  card,
  open,
  busy = false,
  onClose,
  onSubmit,
}: {
  card: SourceCardPublicView
  open: boolean
  busy?: boolean
  onClose: () => void
  onSubmit: (payload: SourceCardPromotePayload) => Promise<void> | void
}) {
  const [reason, setReason] = useState('')
  const [reviewedCapabilityIds, setReviewedCapabilityIds] = useState<string[]>([])
  const [credentialReviewed, setCredentialReviewed] = useState(false)
  const [privacyReviewed, setPrivacyReviewed] = useState(false)
  const [prohibitedReviewed, setProhibitedReviewed] = useState(false)
  const [privateMetadataConfirmed, setPrivateMetadataConfirmed] = useState(false)

  if (!open) return null

  const watchableCapabilityIds = card.capabilities
    .filter((capability) => capability.watchable)
    .map((capability) => capability.id)
  const schemaValid = true
  const stateAllowed = canOpenPromote(card)
  const watchableCapabilitiesReviewed =
    watchableCapabilityIds.length === 0 ||
    watchableCapabilityIds.every((id) => reviewedCapabilityIds.includes(id))
  const privateSource = isPrivateSource(card)
  const privateScopeConfirmed = !privateSource || privateMetadataConfirmed
  const canSubmit =
    reason.trim().length > 0 &&
    schemaValid &&
    stateAllowed &&
    watchableCapabilitiesReviewed &&
    credentialReviewed &&
    privacyReviewed &&
    prohibitedReviewed &&
    privateScopeConfirmed

  function toggleCapability(id: string) {
    setReviewedCapabilityIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    )
  }

  async function submit() {
    if (!canSubmit) return
    const privateScopeConfirmation: SourceCardPromotePayload['privateScopeConfirmation'] =
      privateSource
        ? {
            metadataOnly: true,
            bodyAccessApproved: false,
            attachmentAccessApproved: false,
          }
        : undefined
    await onSubmit({
      reason: reason.trim(),
      reviewedCapabilityIds,
      privateScopeConfirmation,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/45">
      <div className="flex h-full w-full max-w-[560px] flex-col border-l border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4">
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--color-text-primary)]">
              Promote Source Card
            </h2>
            <p className="mt-1 font-mono text-[11px] text-[var(--color-text-disabled)]">
              {card.id}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-white/[0.06] hover:text-[var(--color-text-primary)]"
            aria-label="Close promotion review"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section>
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-disabled)]">
              Approval Checklist
            </h3>
            <div className="mt-3 space-y-2">
              <ReviewCheckRow label="schema valid" checked={schemaValid} />
              <ReviewCheckRow label="state is verified/degraded" checked={stateAllowed} />
              <ReviewCheckRow
                label="watchable capabilities reviewed"
                checked={watchableCapabilitiesReviewed}
              />
              <ReviewCheckRow
                label="credential binding summary reviewed"
                checked={credentialReviewed}
              />
              <ReviewCheckRow label="privacy policy reviewed" checked={privacyReviewed} />
              <ReviewCheckRow label="prohibited actions reviewed" checked={prohibitedReviewed} />
              <ReviewCheckRow
                label="private metadata-only scope confirmed"
                checked={privateScopeConfirmed}
              />
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-disabled)]">
              Capabilities
            </h3>
            {card.capabilities.map((capability) => (
              <label
                key={capability.id}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-[var(--color-border)] bg-white/[0.02] p-3"
              >
                <input
                  type="checkbox"
                  checked={reviewedCapabilityIds.includes(capability.id)}
                  onChange={() => toggleCapability(capability.id)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block font-mono text-[12px] text-[var(--color-text-primary)]">
                    {capability.id}
                  </span>
                  <span className="mt-1 block text-[11px] text-[var(--color-text-muted)]">
                    {capability.operation} · {capability.watchable ? 'watchable' : 'not watchable'}{' '}
                    · {capability.defaultPrivacyScope}
                  </span>
                </span>
              </label>
            ))}
          </section>

          <section className="space-y-2">
            <label className="flex items-start gap-3 text-[12px] text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={credentialReviewed}
                onChange={(event) => setCredentialReviewed(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Reviewed credential binding summary: {card.credentialBindings.length} binding
                {card.credentialBindings.length === 1 ? '' : 's'}, reference presence only.
              </span>
            </label>
            <label className="flex items-start gap-3 text-[12px] text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={privacyReviewed}
                onChange={(event) => setPrivacyReviewed(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Reviewed privacy policy: body {card.privacy.bodyPolicy}, attachments{' '}
                {card.privacy.attachmentPolicy}.
              </span>
            </label>
            <label className="flex items-start gap-3 text-[12px] text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={prohibitedReviewed}
                onChange={(event) => setProhibitedReviewed(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Reviewed prohibited actions across all capabilities. Promotion does not execute
                adapters, create watches, or perform remote writes.
              </span>
            </label>
            {privateSource && (
              <label className="flex items-start gap-3 rounded-md border border-amber-400/25 bg-amber-400/[0.05] p-3 text-[12px] text-[var(--color-text-secondary)]">
                <input
                  type="checkbox"
                  checked={privateMetadataConfirmed}
                  onChange={(event) => setPrivateMetadataConfirmed(event.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Confirm private metadata-only scope. Background body access and attachment access
                  remain rejected.
                </span>
              </label>
            )}
          </section>

          <section>
            <label className="text-[12px] font-medium text-[var(--color-text-secondary)]">
              Promotion reason
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="input-field mt-2 min-h-[92px] w-full resize-y"
                placeholder="Describe the reviewed evidence and approval boundary."
              />
            </label>
          </section>
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-[12px] text-[var(--color-text-muted)] hover:bg-white/[0.06] hover:text-[var(--color-text-primary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit || busy}
            onClick={submit}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--color-accent)] px-3 py-2 text-[12px] font-medium text-black disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-[var(--color-text-disabled)]"
          >
            <CheckCircle size={14} />
            {busy ? 'Promoting...' : 'Promote'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ReviewCheckRow({ label, checked }: { label: string; checked: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-white/[0.025] px-3 py-2">
      <span className="text-[12px] text-[var(--color-text-secondary)]">{label}</span>
      <span
        className={`inline-flex items-center gap-1 text-[11px] ${
          checked ? 'text-emerald-400' : 'text-[var(--color-text-disabled)]'
        }`}
      >
        <CheckCircle size={13} />
        {checked ? 'checked' : 'pending'}
      </span>
    </div>
  )
}

export function RetireSourceDialog({
  card,
  open,
  busy = false,
  onClose,
  onSubmit,
}: {
  card: SourceCardPublicView
  open: boolean
  busy?: boolean
  onClose: () => void
  onSubmit: (reason: string) => Promise<void> | void
}) {
  const [reason, setReason] = useState('')

  if (!open) return null

  const canSubmit = reason.trim().length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="w-full max-w-[520px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4">
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--color-text-primary)]">
              Retire Source Card
            </h2>
            <p className="mt-1 font-mono text-[11px] text-[var(--color-text-disabled)]">
              {card.id}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-white/[0.06] hover:text-[var(--color-text-primary)]"
            aria-label="Close retire dialog"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-[12px] leading-5 text-[var(--color-text-secondary)]">
            Retiring this Source Card prevents future Watch bindings from referencing it. Existing
            observations remain audit records, and no credential values or adapter templates are
            exposed by this action.
          </p>
          <label className="text-[12px] font-medium text-[var(--color-text-secondary)]">
            Retire reason
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="input-field mt-2 min-h-[92px] w-full resize-y"
              placeholder="Explain why this source should no longer be used."
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-[12px] text-[var(--color-text-muted)] hover:bg-white/[0.06] hover:text-[var(--color-text-primary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit || busy}
            onClick={() => {
              if (canSubmit) void onSubmit(reason.trim())
            }}
            className="rounded-md bg-red-400 px-3 py-2 text-[12px] font-medium text-black disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-[var(--color-text-disabled)]"
          >
            {busy ? 'Retiring...' : 'Retire Source Card'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DetailSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-white/[0.02] p-4">
      <h2 className="mb-3 text-[14px] font-semibold text-[var(--color-text-primary)]">{title}</h2>
      {children}
    </section>
  )
}

function KeyValueGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-2 md:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-disabled)]">
            {label}
          </div>
          <div className="mt-0.5 break-words text-[12px] text-[var(--color-text-secondary)]">
            {value}
          </div>
        </div>
      ))}
    </div>
  )
}

function ObservationSummaryPanel({
  summary,
}: {
  summary: SourceObservationSummaryResponse | null
}) {
  return (
    <DetailSection title="Observation Summary">
      {!summary ? (
        <p className="text-[12px] text-[var(--color-text-muted)]">
          Observation summary unavailable.
        </p>
      ) : summary.summary.total === 0 ? (
        <p className="text-[12px] text-[var(--color-text-muted)]">
          No observations recorded. Source Card definitions are separate from high-frequency data.
        </p>
      ) : (
        <div className="space-y-3">
          <KeyValueGrid
            rows={[
              ['Total observations', String(summary.summary.total)],
              ['Last observed', summary.summary.lastObservedAt ?? 'Never'],
              ['Capabilities', summary.summary.capabilityIds.join(', ') || 'None'],
              ['Latest failure', summary.summary.latestFailureClass ?? 'None'],
            ]}
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[12px]">
              <thead className="text-[11px] uppercase tracking-wide text-[var(--color-text-disabled)]">
                <tr>
                  <th className="border-b border-[var(--color-border)] py-2 pr-3">Kind</th>
                  <th className="border-b border-[var(--color-border)] py-2 pr-3">Capability</th>
                  <th className="border-b border-[var(--color-border)] py-2 pr-3">Observed</th>
                  <th className="border-b border-[var(--color-border)] py-2 pr-3">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {summary.observations.map((observation) => (
                  <tr
                    key={observation.id ?? `${observation.capabilityId}-${observation.observedAt}`}
                  >
                    <td className="border-b border-[var(--color-border)] py-2 pr-3 text-[var(--color-text-secondary)]">
                      {observation.kind}
                    </td>
                    <td className="border-b border-[var(--color-border)] py-2 pr-3 font-mono text-[var(--color-text-secondary)]">
                      {observation.capabilityId}
                    </td>
                    <td className="border-b border-[var(--color-border)] py-2 pr-3 text-[var(--color-text-muted)]">
                      {formatTimeAgo(observation.observedAt)}
                    </td>
                    <td className="border-b border-[var(--color-border)] py-2 pr-3 text-[var(--color-text-muted)]">
                      {formatEvidence(observation.evidence)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </DetailSection>
  )
}

function formatEvidence(evidence: SourceObservationSummaryRow['evidence']): string {
  if (!evidence) return 'No evidence'
  const parts = [
    evidence.statusCode ? `HTTP ${evidence.statusCode}` : '',
    evidence.exitCode !== undefined ? `exit ${evidence.exitCode}` : '',
    evidence.durationMs ? `${evidence.durationMs}ms` : '',
    evidence.rowCount !== undefined ? `${evidence.rowCount} rows` : '',
    evidence.schemaKeys?.length ? `schema: ${evidence.schemaKeys.join(', ')}` : '',
    evidence.failureClass ? `failure: ${evidence.failureClass}` : '',
  ].filter(Boolean)
  return parts.join(' · ') || 'Sanitized evidence'
}

function SafetyBoundary({ card }: { card: SourceCardPublicView }) {
  if (isPrivateSource(card)) {
    return (
      <ul className="space-y-2 text-[12px] text-[var(--color-text-muted)]">
        <li>Metadata only by default.</li>
        <li>Mail body content is hidden from this UI.</li>
        <li>Attachments are blocked for background watch.</li>
        <li>Credential references and secret values are never rendered.</li>
      </ul>
    )
  }

  if (isMarketSource(card)) {
    return (
      <ul className="space-y-2 text-[12px] text-[var(--color-text-muted)]">
        <li>Public read-only market data.</li>
        <li>No broker login, account access, or trading actions.</li>
        <li>No order placement or automatic rebalancing.</li>
        <li>Watch may only notify, record observations, or create artifacts.</li>
      </ul>
    )
  }

  return (
    <ul className="space-y-2 text-[12px] text-[var(--color-text-muted)]">
      <li>Read-only Source Card inspection.</li>
      <li>No credential values are displayed.</li>
      <li>No source adapter is executed from this screen.</li>
    </ul>
  )
}
