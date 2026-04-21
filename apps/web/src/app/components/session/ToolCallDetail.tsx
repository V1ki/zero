import {
  ArrowsClockwise,
  Database,
  FileArrowDown,
  FileText,
  GlobeHemisphereWest,
  MagnifyingGlass,
  NotePencil,
  TerminalWindow,
  WarningCircle,
} from '@phosphor-icons/react'
import type { ReactNode } from 'react'

interface ToolCallDetailProps {
  name: string
  input: Record<string, unknown>
  result?: string
  summary?: string
  isError?: boolean
  status?: 'running' | 'success' | 'error'
  durationMs?: number
  abortPending?: boolean
  onAbort?: () => void
  nested?: boolean
}

type DiffRow =
  | { type: 'common'; text: string }
  | { type: 'removed'; text: string }
  | { type: 'added'; text: string }
  | { type: 'omitted'; text: string }

const stderrMarker = '\n[stderr]\n'

export function ToolCallDetail({
  name,
  input,
  result,
  summary,
  isError,
  status,
  durationMs,
  abortPending,
  onAbort,
  nested = false,
}: ToolCallDetailProps) {
  const toolName = getToolName(name)

  switch (toolName) {
    case 'bash':
      return (
        <BashToolDetail
          input={input}
          result={result}
          summary={summary}
          isError={isError}
          status={status}
          durationMs={durationMs}
          abortPending={abortPending}
          onAbort={onAbort}
          nested={nested}
        />
      )
    case 'edit':
      return (
        <EditToolDetail
          input={input}
          result={result}
          summary={summary}
          isError={isError}
          nested={nested}
        />
      )
    case 'read':
      return <ReadToolDetail input={input} result={result} isError={isError} nested={nested} />
    case 'write':
      return (
        <WriteToolDetail
          input={input}
          result={result}
          summary={summary}
          isError={isError}
          nested={nested}
        />
      )
    case 'memory':
      return (
        <MemoryToolDetail
          input={input}
          result={result}
          summary={summary}
          isError={isError}
          nested={nested}
        />
      )
    case 'memory_search':
      return (
        <MemorySearchToolDetail
          input={input}
          result={result}
          summary={summary}
          isError={isError}
          nested={nested}
        />
      )
    case 'memory_read':
      return (
        <MemoryReadToolDetail
          input={input}
          result={result}
          summary={summary}
          isError={isError}
          nested={nested}
        />
      )
    case 'fetch':
      return (
        <FetchToolDetail
          input={input}
          result={result}
          summary={summary}
          isError={isError}
          nested={nested}
        />
      )
    default:
      return (
        <GenericToolDetail
          name={name}
          input={input}
          result={result}
          summary={summary}
          isError={isError}
          nested={nested}
        />
      )
  }
}

export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const toolName = getToolName(name)

  if (toolName === 'bash') {
    return stringValue(input.command)?.replace(/\s+/g, ' ').slice(0, 120) ?? ''
  }

  if (toolName === 'fetch') {
    const method = stringValue(input.method) ?? 'GET'
    const url = stringValue(input.url) ?? ''
    return `${method} ${url}`.trim().slice(0, 120)
  }

  if (toolName === 'memory_search') {
    return stringValue(input.query)?.slice(0, 120) ?? ''
  }

  if (toolName === 'memory') {
    const action = stringValue(input.action)
    const type = stringValue(input.type)
    const title = stringValue(input.title)
    return [action, type, title].filter(Boolean).join(' ').slice(0, 120)
  }

  if (toolName === 'memory_read') {
    return (
      stringValue(input.path) ??
      stringValue(input.id) ??
      stringValue(input.memoryId) ??
      ''
    ).slice(0, 120)
  }

  if (toolName === 'edit' || toolName === 'read' || toolName === 'write') {
    return stringValue(input.path) ?? stringValue(input.file_path) ?? ''
  }

  if ('path' in input && typeof input.path === 'string') return input.path
  if ('file_path' in input && typeof input.file_path === 'string') return input.file_path
  if ('url' in input && typeof input.url === 'string') return input.url
  if ('query' in input && typeof input.query === 'string') return input.query
  if ('instruction' in input && typeof input.instruction === 'string') {
    return input.instruction.slice(0, 120)
  }

  const firstString = Object.values(input).find((value) => typeof value === 'string')
  return typeof firstString === 'string' ? firstString.slice(0, 120) : ''
}

function BashToolDetail({
  input,
  result,
  summary,
  isError,
  status,
  durationMs,
  abortPending,
  onAbort,
  nested,
}: Omit<ToolCallDetailProps, 'name'>) {
  const command = stringValue(input.command) ?? '(missing command)'
  const description = stringValue(input.description)
  const timeout = numberValue(input.timeout)
  const displayOutput = resolveToolOutput('bash', result, summary)
  const runSummary = resolveToolSummary('bash', result, summary)
  const { stdout, stderr } = splitToolResult(displayOutput)
  const hasOutput = Boolean(stdout || stderr)
  const stdoutLines = countLines(stdout)
  const stderrLines = countLines(stderr)

  return (
    <DetailShell dataTool="bash" nested={nested}>
      <ToolMetaRow>
        {description ? <MetaChip>{description}</MetaChip> : null}
        {timeout !== undefined ? <MetaChip>timeout {timeout}ms</MetaChip> : null}
        {durationMs !== undefined ? <MetaChip>ran {formatDuration(durationMs)}</MetaChip> : null}
        {hasOutput && stdout ? <MetaChip>stdout {stdoutLines} lines</MetaChip> : null}
        {hasOutput && stderr ? <MetaChip>stderr {stderrLines} lines</MetaChip> : null}
        <StatusChip isError={isError} />
      </ToolMetaRow>

      {status === 'running' && onAbort ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onAbort}
            disabled={abortPending}
            className="rounded-xl border border-rose-400/25 bg-rose-400/8 px-3 py-1.5 text-[11px] text-rose-100 transition-colors hover:border-rose-400/40 hover:bg-rose-400/14 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {abortPending ? 'Aborting...' : 'Abort'}
          </button>
        </div>
      ) : null}

      {runSummary ? <InfoStrip tone="cyan" label="Run Summary" text={runSummary} /> : null}

      <SectionLabel icon={<TerminalWindow size={14} />} title="Command" />
      <TerminalSurface>
        <div className="border-b border-white/8 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
          shell
        </div>
        <pre className="px-3 py-2 text-[11px] leading-[1.15rem] text-cyan-100 whitespace-pre-wrap break-words">
          <span className="text-emerald-300">$ </span>
          {command}
        </pre>
      </TerminalSurface>

      <SectionLabel
        icon={<FileText size={14} />}
        title={hasOutput ? 'Captured Output' : 'Execution Evidence'}
      />
      {hasOutput ? (
        <TerminalSurface>
          <div className="border-b border-white/8 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
            stdout
          </div>
          <pre className="max-h-[320px] overflow-y-auto px-3 py-2 text-[10.5px] leading-[1.15rem] text-slate-200 whitespace-pre-wrap break-words">
            {stdout || '(no stdout)'}
          </pre>
          {stderr ? (
            <>
              <div className="border-t border-white/8 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-amber-300">
                stderr
              </div>
              <pre className="max-h-[220px] overflow-y-auto px-3 py-2 text-[10.5px] leading-[1.15rem] text-amber-100 whitespace-pre-wrap break-words">
                {stderr}
              </pre>
            </>
          ) : null}
        </TerminalSurface>
      ) : (
        <EmptyStateStrip
          title={
            status === 'running'
              ? 'This command is still running and has not produced a persisted tool result yet.'
              : 'This run did not persist stdout/stderr in session history.'
          }
          detail={
            status === 'running'
              ? 'Abort is available while the process is still live. Output will appear once the run finishes.'
              : 'The command succeeded, but only the execution marker was recorded for this step.'
          }
        />
      )}
    </DetailShell>
  )
}

function EditToolDetail({
  input,
  result,
  summary,
  isError,
  nested,
}: Omit<ToolCallDetailProps, 'name' | 'durationMs'>) {
  const path = stringValue(input.path) ?? '(missing path)'
  const oldText = stringValue(input.oldText) ?? ''
  const newText = stringValue(input.newText) ?? ''
  const diffRows = buildReplacementDiff(oldText, newText)
  const { addedCount, removedCount } = countDiffRows(diffRows)
  const detailSummary = resolveToolSummary('edit', result, summary)

  return (
    <DetailShell dataTool="edit" nested={nested}>
      <ToolMetaRow>
        <MetaChip>{path}</MetaChip>
        <MetaChip>
          {countLines(oldText)}
          {' -> '}
          {countLines(newText)} lines
        </MetaChip>
        <MetaChip>{removedCount} removed</MetaChip>
        <MetaChip>{addedCount} added</MetaChip>
        <StatusChip isError={isError} />
      </ToolMetaRow>

      {detailSummary ? <InfoStrip tone="amber" label="Patch Result" text={detailSummary} /> : null}

      <SectionLabel icon={<NotePencil size={14} />} title="Patch Preview" />
      <div className="overflow-hidden rounded-2xl border border-amber-400/12 bg-[linear-gradient(180deg,rgba(32,20,7,0.26),rgba(10,14,20,0.72))]">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 border-b border-amber-400/10 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-amber-100/65">
          <span>Op</span>
          <span>Replacement Preview</span>
        </div>
        <div className="max-h-[360px] overflow-y-auto">
          {diffRows.map((row, index) => (
            <div
              key={`${row.type}-${index}`}
              className={`grid grid-cols-[auto_1fr] gap-x-3 px-3 py-0.5 font-mono text-[10.5px] leading-[1.15rem] ${
                row.type === 'removed'
                  ? 'bg-red-400/10 text-red-100'
                  : row.type === 'added'
                    ? 'bg-emerald-400/10 text-emerald-100'
                    : row.type === 'omitted'
                      ? 'bg-white/[0.03] text-[var(--color-text-disabled)]'
                      : 'text-slate-300'
              }`}
            >
              <span className="select-none">
                {row.type === 'removed'
                  ? '-'
                  : row.type === 'added'
                    ? '+'
                    : row.type === 'omitted'
                      ? '…'
                      : ' '}
              </span>
              <span className="whitespace-pre-wrap break-words">{row.text || ' '}</span>
            </div>
          ))}
        </div>
      </div>
    </DetailShell>
  )
}

function ReadToolDetail({
  input,
  result,
  isError,
  nested,
}: Omit<ToolCallDetailProps, 'name' | 'durationMs'>) {
  const path = stringValue(input.path) ?? '(missing path)'
  const offset = numberValue(input.offset) ?? 0
  const limit = numberValue(input.limit)
  const lines = (result ?? '').split('\n')

  return (
    <DetailShell dataTool="read" nested={nested}>
      <ToolMetaRow>
        <MetaChip>{path}</MetaChip>
        {offset > 0 ? <MetaChip>offset {offset}</MetaChip> : null}
        {limit !== undefined ? <MetaChip>limit {limit}</MetaChip> : null}
        {lines.length > 0 ? <MetaChip>showing {lines.length} lines</MetaChip> : null}
        <StatusChip isError={isError} />
      </ToolMetaRow>

      <SectionLabel icon={<FileText size={14} />} title="File Snapshot" />
      <CodeViewer lines={lines} startLine={offset + 1} />
    </DetailShell>
  )
}

function WriteToolDetail({
  input,
  result,
  summary,
  isError,
  nested,
}: Omit<ToolCallDetailProps, 'name' | 'durationMs'>) {
  const path = stringValue(input.path) ?? '(missing path)'
  const content = stringValue(input.content) ?? ''
  const lines = content.split('\n')
  const detailSummary = resolveToolSummary('write', result, summary)

  return (
    <DetailShell dataTool="write" nested={nested}>
      <ToolMetaRow>
        <MetaChip>{path}</MetaChip>
        <MetaChip>{content.length} chars</MetaChip>
        <MetaChip>{countLines(content)} lines</MetaChip>
        <StatusChip isError={isError} />
      </ToolMetaRow>

      <div className="rounded-2xl border border-emerald-400/15 bg-[linear-gradient(180deg,rgba(6,78,59,0.2),rgba(5,10,15,0.18))] px-3 py-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/70">
              Write Target
            </p>
            <p className="mt-1 break-all font-mono text-[11px] leading-[1.15rem] text-emerald-100">
              {path}
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-x-3 gap-y-1 text-right text-[10px] text-emerald-100/75">
            <span>chars</span>
            <span>{content.length}</span>
            <span>lines</span>
            <span>{countLines(content)}</span>
          </div>
        </div>
        {detailSummary ? (
          <div className="mt-2 rounded-xl border border-emerald-300/12 bg-emerald-300/[0.05] px-2.5 py-1.5 text-[10.5px] leading-[1.1rem] text-emerald-50/90">
            {detailSummary}
          </div>
        ) : null}
      </div>

      <SectionLabel icon={<FileArrowDown size={14} />} title="Payload" />
      <CodeViewer lines={lines} tone="emerald" />
    </DetailShell>
  )
}

function MemoryToolDetail({
  input,
  result,
  summary,
  isError,
  nested,
}: Omit<ToolCallDetailProps, 'name' | 'durationMs'>) {
  const action = stringValue(input.action) ?? 'create'
  const type = stringValue(input.type) ?? 'note'
  const title = stringValue(input.title) ?? '(untitled memory)'
  const tags = Array.isArray(input.tags)
    ? input.tags.filter((tag): tag is string => typeof tag === 'string')
    : []
  const content = stringValue(input.content) ?? ''
  const memoryId = stringValue(input.id) ?? stringValue(input.memoryId)
  const detailSummary = resolveToolSummary('memory', result, summary)

  return (
    <DetailShell dataTool="memory" nested={nested}>
      <ToolMetaRow>
        <MetaChip>{action}</MetaChip>
        <MetaChip>{type}</MetaChip>
        {memoryId ? <MetaChip>{memoryId}</MetaChip> : null}
        {tags.length > 0 ? <MetaChip>{tags.length} tags</MetaChip> : null}
        <StatusChip isError={isError} />
      </ToolMetaRow>

      <div className="rounded-2xl border border-emerald-400/15 bg-[linear-gradient(180deg,rgba(6,78,59,0.18),rgba(10,14,20,0.7))] px-3 py-2">
        <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/70">Memory Target</p>
        <p className="mt-1 text-[12px] font-medium text-emerald-50">{title}</p>
        {tags.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-emerald-300/12 bg-emerald-300/[0.05] px-2 py-0.5 text-[10px] font-mono text-emerald-100/85"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        {detailSummary ? (
          <div className="mt-2 rounded-xl border border-emerald-300/12 bg-emerald-300/[0.05] px-2.5 py-1.5 text-[10.5px] leading-[1.1rem] text-emerald-50/90">
            {detailSummary}
          </div>
        ) : null}
      </div>

      {content ? (
        <>
          <SectionLabel icon={<Database size={14} />} title="Memory Content" />
          <CodeViewer lines={content.split('\n')} tone="emerald" />
        </>
      ) : null}
    </DetailShell>
  )
}

function MemorySearchToolDetail({
  input,
  result,
  summary,
  isError,
  nested,
}: Omit<ToolCallDetailProps, 'name' | 'durationMs'>) {
  const query = stringValue(input.query) ?? '(missing query)'
  const topK = numberValue(input.topK) ?? numberValue(input.limit)
  const detailSummary = resolveToolSummary('memory_search', result, summary)

  return (
    <DetailShell dataTool="memory_search" nested={nested}>
      <ToolMetaRow>
        {topK !== undefined ? <MetaChip>top {topK}</MetaChip> : null}
        <StatusChip isError={isError} />
      </ToolMetaRow>

      {detailSummary ? <InfoStrip tone="cyan" label="Search Result" text={detailSummary} /> : null}

      <SectionLabel icon={<MagnifyingGlass size={14} />} title="Query" />
      <div className="rounded-xl border border-cyan-400/12 bg-cyan-400/[0.05] px-3 py-2 text-[11px] text-cyan-100 break-words">
        {query}
      </div>

      {isMeaningfulToolResult(result) ? (
        <>
          <SectionLabel icon={<FileText size={14} />} title="Output" />
          <CodeViewer lines={(result ?? '').split('\n')} />
        </>
      ) : null}
    </DetailShell>
  )
}

function MemoryReadToolDetail({
  input,
  result,
  summary,
  isError,
  nested,
}: Omit<ToolCallDetailProps, 'name' | 'durationMs'>) {
  const target =
    stringValue(input.path) ??
    stringValue(input.id) ??
    stringValue(input.memoryId) ??
    '(missing target)'
  const detailSummary = resolveToolSummary('memory_read', result, summary)

  return (
    <DetailShell dataTool="memory_read" nested={nested}>
      <ToolMetaRow>
        <MetaChip>{target}</MetaChip>
        <StatusChip isError={isError} />
      </ToolMetaRow>

      {detailSummary ? <InfoStrip tone="blue" label="Read Summary" text={detailSummary} /> : null}

      {isMeaningfulToolResult(result) ? (
        <>
          <SectionLabel icon={<Database size={14} />} title="Memory Payload" />
          <CodeViewer lines={(result ?? '').split('\n')} />
        </>
      ) : (
        <EmptyStateStrip
          title="This memory read did not persist body content."
          detail="Only the target identifier was recorded for this step."
        />
      )}
    </DetailShell>
  )
}

function FetchToolDetail({
  input,
  result,
  summary,
  isError,
  nested,
}: Omit<ToolCallDetailProps, 'name' | 'durationMs'>) {
  const method = stringValue(input.method) ?? 'GET'
  const url = stringValue(input.url) ?? '(missing url)'
  const timeout = numberValue(input.timeout)
  const format = stringValue(input.format)
  const parsed = parseFetchResult(result)
  const detailSummary = resolveToolSummary('fetch', result, summary)

  return (
    <DetailShell dataTool="fetch" nested={nested}>
      <ToolMetaRow>
        <MetaChip>{method}</MetaChip>
        {format ? <MetaChip>{format}</MetaChip> : null}
        {timeout !== undefined ? <MetaChip>{timeout}ms</MetaChip> : null}
        {parsed.statusLabel ? <MetaChip>{parsed.statusLabel}</MetaChip> : null}
        <StatusChip isError={isError} />
      </ToolMetaRow>

      {detailSummary ? <InfoStrip tone="blue" label="Fetch Summary" text={detailSummary} /> : null}

      <SectionLabel icon={<GlobeHemisphereWest size={14} />} title="Request" />
      <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2 text-[12px] text-[var(--color-text-secondary)] break-all">
        {url}
      </div>

      <SectionLabel icon={<FileText size={14} />} title="Response" />
      <CodeViewer lines={formatFetchBody(parsed.body)} />
    </DetailShell>
  )
}

function GenericToolDetail({
  name,
  input,
  result,
  summary,
  isError,
  nested,
}: Omit<ToolCallDetailProps, 'durationMs'>) {
  const detailSummary = resolveToolSummary(getToolName(name), result, summary)

  return (
    <DetailShell dataTool={getToolName(name)} nested={nested}>
      <ToolMetaRow>
        <MetaChip>{name}</MetaChip>
        <StatusChip isError={isError} />
      </ToolMetaRow>

      {detailSummary ? <InfoStrip tone="slate" label="Summary" text={detailSummary} /> : null}

      <SectionLabel icon={<ArrowsClockwise size={14} />} title="Input" />
      <pre className="max-h-[220px] overflow-y-auto rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2 text-[10.5px] leading-[1.15rem] text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
        {JSON.stringify(input, null, 2)}
      </pre>

      {isMeaningfulToolResult(result) ? (
        <>
          <SectionLabel icon={<FileText size={14} />} title="Output" />
          <pre className="max-h-[260px] overflow-y-auto rounded-xl border border-white/8 bg-[rgba(10,14,20,0.7)] px-3 py-2 text-[10.5px] leading-[1.15rem] text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
            {result}
          </pre>
        </>
      ) : null}
    </DetailShell>
  )
}

function DetailShell({
  children,
  dataTool,
  nested,
}: {
  children: ReactNode
  dataTool: string
  nested?: boolean
}) {
  return (
    <div
      data-tool-renderer={dataTool}
      className={`space-y-2 border-t border-white/[0.06] ${nested ? 'px-3 py-2.5' : 'px-4 py-3'}`}
    >
      {children}
    </div>
  )
}

function ToolMetaRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5">{children}</div>
}

function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]">
      {children}
    </span>
  )
}

function StatusChip({ isError }: { isError?: boolean }) {
  if (isError === undefined) return null
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${
        isError
          ? 'border-red-400/30 bg-red-400/12 text-red-200'
          : 'border-emerald-400/30 bg-emerald-400/12 text-emerald-200'
      }`}
    >
      {isError ? 'error' : 'ok'}
    </span>
  )
}

function SectionLabel({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-disabled)]">
      <span className="text-[var(--color-text-secondary)]">{icon}</span>
      <span>{title}</span>
    </div>
  )
}

function TerminalSurface({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(9,11,16,0.98),rgba(13,18,26,0.94))] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      {children}
    </div>
  )
}

function CodeViewer({
  lines,
  startLine = 1,
  tone = 'default',
}: {
  lines: string[]
  startLine?: number
  tone?: 'default' | 'emerald'
}) {
  const lineColor =
    tone === 'emerald' ? 'text-emerald-100/90' : 'text-[var(--color-text-secondary)]'

  return (
    <div className="overflow-hidden rounded-2xl border border-white/8 bg-[rgba(10,14,20,0.7)]">
      <div className="max-h-[320px] overflow-y-auto">
        {lines.map((line, index) => (
          <div
            key={`${startLine + index}-${line}`}
            className="grid grid-cols-[auto_1fr] gap-x-2.5 px-3 py-0.5 font-mono text-[10.5px] leading-[1.15rem]"
          >
            <span className="select-none text-[var(--color-text-disabled)]">{startLine + index}</span>
            <span className={`whitespace-pre-wrap break-words ${lineColor}`}>
              {line || ' '}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function InfoStrip({
  tone,
  label,
  text,
}: {
  tone: 'cyan' | 'amber' | 'emerald' | 'blue' | 'slate'
  label: string
  text: string
}) {
  const toneClass =
    tone === 'cyan'
      ? 'border-cyan-400/15 bg-cyan-400/[0.06] text-cyan-100'
      : tone === 'amber'
        ? 'border-amber-400/15 bg-amber-400/[0.06] text-amber-100'
        : tone === 'emerald'
          ? 'border-emerald-400/15 bg-emerald-400/[0.06] text-emerald-100'
          : tone === 'blue'
            ? 'border-sky-400/15 bg-sky-400/[0.06] text-sky-100'
            : 'border-white/8 bg-white/[0.03] text-[var(--color-text-secondary)]'

  return (
    <div className={`rounded-xl border px-3 py-1.5 ${toneClass}`}>
      <p className="text-[10px] uppercase tracking-[0.18em] opacity-70">{label}</p>
      <p className="mt-1 text-[10.5px] leading-[1.15rem]">{text}</p>
    </div>
  )
}

function EmptyStateStrip({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2">
      <p className="text-[10.5px] font-medium text-[var(--color-text-secondary)]">{title}</p>
      <p className="mt-1 text-[10.5px] leading-[1.15rem] text-[var(--color-text-muted)]">{detail}</p>
    </div>
  )
}

function buildReplacementDiff(oldText: string, newText: string): DiffRow[] {
  const before = normalizeLines(oldText)
  const after = normalizeLines(newText)

  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const rows: DiffRow[] = []
  const headContextStart = Math.max(0, prefix - 2)
  const headContext = before.slice(headContextStart, prefix)
  const removed = before.slice(prefix, before.length - suffix)
  const added = after.slice(prefix, after.length - suffix)
  const tailContext = suffix > 0 ? before.slice(before.length - Math.min(suffix, 2)) : []

  if (headContextStart > 0) {
    rows.push({ type: 'omitted', text: `${headContextStart} unchanged lines` })
  }
  for (const line of headContext) {
    rows.push({ type: 'common', text: line })
  }
  for (const line of removed) {
    rows.push({ type: 'removed', text: line })
  }
  for (const line of added) {
    rows.push({ type: 'added', text: line })
  }
  for (const line of tailContext) {
    rows.push({ type: 'common', text: line })
  }
  if (suffix > tailContext.length) {
    rows.push({ type: 'omitted', text: `${suffix - tailContext.length} unchanged lines` })
  }

  if (rows.length === 0) {
    rows.push({ type: 'common', text: '(no visible diff)' })
  }

  return rows
}

function normalizeLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').split('\n')
}

function splitToolResult(result?: string) {
  if (!result) return { stdout: '', stderr: '' }
  const markerIndex = result.indexOf(stderrMarker)
  if (markerIndex === -1) return { stdout: result, stderr: '' }
  return {
    stdout: result.slice(0, markerIndex),
    stderr: result.slice(markerIndex + stderrMarker.length),
  }
}

function parseFetchResult(result?: string) {
  if (!result) return { statusLabel: '', body: '' }
  const [firstLine, ...rest] = result.split('\n')
  const body = rest.join('\n').replace(/^\n+/, '')
  return {
    statusLabel: firstLine.startsWith('HTTP ') ? firstLine : '',
    body: firstLine.startsWith('HTTP ') ? body : result,
  }
}

function formatFetchBody(body: string): string[] {
  const trimmed = body.trim()
  if (!trimmed) return ['(empty response body)']

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2).split('\n')
    } catch {
      return body.split('\n')
    }
  }

  return body.split('\n')
}

function resolveToolOutput(toolName: string, result?: string, summary?: string) {
  if (isMeaningfulToolResult(result)) return normalizeResult(result)
  if (toolName === 'bash') {
    const normalizedSummary = normalizeResult(summary)
    if (
      normalizedSummary &&
      !normalizedSummary.startsWith('Executed:') &&
      !isGenericToolStatus(normalizedSummary)
    ) {
      return normalizedSummary
    }
    return undefined
  }
  if (isMeaningfulToolResult(summary)) return normalizeResult(summary)
  return undefined
}

function resolveToolSummary(toolName: string, result?: string, summary?: string) {
  const normalizedSummary = normalizeResult(summary)
  const normalizedResult = normalizeResult(result)

  if (toolName === 'bash') {
    if (normalizedSummary && !normalizedSummary.startsWith('Executed:')) return normalizedSummary
    return undefined
  }

  if (normalizedSummary && !isGenericToolStatus(normalizedSummary)) return normalizedSummary
  if (normalizedResult && !isGenericToolStatus(normalizedResult)) return normalizedResult
  return undefined
}

function isMeaningfulToolResult(value?: string) {
  const normalized = normalizeResult(value)
  return Boolean(normalized && !isGenericToolStatus(normalized))
}

function isGenericToolStatus(value: string) {
  const normalized = value
    .replace(/^[✓✔]\s*/u, '')
    .replace(/^[✗✘]\s*/u, '')
    .trim()
    .toLowerCase()

  return (
    normalized === 'success' ||
    normalized === 'ok' ||
    normalized === 'done' ||
    normalized === 'completed' ||
    normalized === 'passed'
  )
}

function normalizeResult(value?: string) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function countDiffRows(rows: DiffRow[]) {
  let addedCount = 0
  let removedCount = 0

  for (const row of rows) {
    if (row.type === 'added') addedCount += 1
    if (row.type === 'removed') removedCount += 1
  }

  return { addedCount, removedCount }
}

function getToolName(value: string) {
  const parts = value.split('/')
  return (parts.at(-1) ?? value).toLowerCase()
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function countLines(value: string) {
  if (!value) return 0
  return value.replace(/\r\n/g, '\n').split('\n').length
}

function formatDuration(durationMs: number) {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
}
