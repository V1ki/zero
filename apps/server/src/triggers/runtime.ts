import type { TriggerStore } from '@zero-os/observe'
import type {
  TriggerSettings,
  TriggerSettingsSnapshot,
  TriggerSource,
  TriggerStatus,
  TriggerWxarcSession,
} from '@zero-os/shared'
import { getGithubRepository, listGithubRepositories, pollGithub } from './github'
import type { TriggerRoutingRuntime } from './routing-runtime'
import { listWxarcSessions, pollWxarc } from './wxarc'

const sources = ['github', 'wxarc'] as const
const credentialPattern = /^github_listener(?:_[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?$/
const intervalMs = { github: 300_000, wxarc: 5000 }
type SourceJob = {
  running?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  refreshRequested: boolean
  retryAt: number
}

export class ListenerRuntime {
  private readonly controller = new AbortController()
  private readonly status = new Map<string, TriggerStatus>()
  private readonly jobs: Record<TriggerSource, SourceJob> = {
    github: { refreshRequested: false, retryAt: 0 },
    wxarc: { refreshRequested: false, retryAt: 0 },
  }
  private started = false
  private stopping?: Promise<void>

  constructor(
    private readonly store: TriggerStore,
    private readonly resolveSecret: (ref: string) => string | undefined,
    readonly routing: TriggerRoutingRuntime,
    private readonly connectors = { pollGithub, pollWxarc },
  ) {}

  start(): void {
    if (this.started || this.controller.signal.aborted) return
    this.started = true
    this.routing.start()
    for (const source of sources) this.request(source)
  }

  close(): Promise<void> {
    if (!this.stopping) {
      this.controller.abort()
      for (const job of Object.values(this.jobs)) clearTimeout(job.timer)
      this.stopping = Promise.allSettled([
        this.routing.close(),
        ...sources.map((source) => this.jobs[source].running),
      ]).then(() => this.store.close())
    }
    return this.stopping
  }

  getSettings() {
    return this.store.getSettings()
  }

  saveSettings(settings: TriggerSettings, revision: number, githubLookbackHours?: 1 | 24) {
    const next = this.store.saveSettings(settings, revision, githubLookbackHours)
    if (next !== revision) {
      this.status.clear()
      this.routing.notify()
      for (const source of sources) this.request(source, true)
    }
    return this.getSettings()
  }

  getStatus(): TriggerStatus[] {
    const { settings } = this.getSettings()
    const state = (source: TriggerSource, scope: string, enabled: boolean): TriggerStatus =>
      (enabled && this.status.get(this.key(source, scope))) || {
        source,
        scope,
        state: 'idle',
        lastCheckedAt: null,
      }
    return [
      ...settings.github.repositories.map((row) => state('github', row.name, row.enabled)),
      ...settings.wxarc.sessions.map((row) => state('wxarc', row.id, row.enabled)),
    ]
  }

  listInbox(limit?: number, beforeId?: number) {
    return this.store.listInbox(limit, beforeId)
  }

  async listGithubRepositories(signal: AbortSignal, credentialRef = '', name?: string) {
    const token = this.githubToken(credentialRef)
    if (name) return [await getGithubRepository(name, token, signal)]
    return listGithubRepositories(token, signal)
  }

  listWxarcSessions(signal: AbortSignal) {
    return listWxarcSessions(signal)
  }

  async scan(): Promise<void> {
    for (const source of sources) this.request(source)
  }

  private githubToken(ref: string) {
    if (!ref) return undefined
    if (!credentialPattern.test(ref)) throw new Error('无效的 GitHub 监听凭证引用')
    const token = this.resolveSecret(ref)
    if (!token) throw new Error('指定的 GitHub 监听凭证尚未配置')
    return token
  }

  private key(source: TriggerSource, scope: string) {
    return `${source}:${source === 'github' ? scope.toLowerCase() : scope}`
  }

  private schedule(source: TriggerSource, delay: number) {
    const job = this.jobs[source]
    clearTimeout(job.timer)
    job.timer = setTimeout(() => this.request(source), Math.min(2_147_483_647, Math.max(0, delay)))
    job.timer.unref?.()
  }

  private request(source: TriggerSource, refresh = false): void {
    if (!this.started || this.controller.signal.aborted) return
    const job = this.jobs[source]
    if (job.running) {
      if (refresh) job.refreshRequested = true
      return
    }
    clearTimeout(job.timer)
    if (job.retryAt > Date.now()) {
      this.schedule(source, job.retryAt - Date.now())
      return
    }
    let delay: number | null = intervalMs[source]
    job.running = Promise.resolve()
      .then(async () => {
        const snapshot = this.getSettings()
        delay =
          source === 'github' ? await this.readGithub(snapshot) : await this.readWxarc(snapshot)
      })
      .catch(() => {
        // Unexpected store/driver failure: do not log raw records or advance the failed batch.
        console.error('[Listeners] Could not complete the source scan:', source)
      })
      .finally(() => {
        job.running = undefined
        if (this.controller.signal.aborted) return
        if (job.refreshRequested) delay = 0
        job.refreshRequested = false
        if (delay !== null) this.schedule(source, Math.max(delay, job.retryAt - Date.now()))
      })
  }

  private current(revision: number): boolean {
    return !this.controller.signal.aborted && this.getSettings().revision === revision
  }

  private async readGithub({
    settings,
    revision,
  }: TriggerSettingsSnapshot): Promise<number | null> {
    const repos = settings.github.repositories.filter((row) => row.enabled)
    if (!repos.length) return null
    const signal = this.controller.signal
    for (const repo of repos) {
      if (!this.current(revision) || this.jobs.github.retryAt > Date.now()) break
      const stream = this.key('github', repo.name)
      const cursor = this.store.readCursor(stream)
      const start = this.store.getStreamStartedAt(stream)
      if (!start) continue
      try {
        const token = this.githubToken(settings.github.credentialRef)
        const batch = await this.connectors.pollGithub(repo, cursor, token, signal, start)
        if (!this.current(revision)) break
        if (
          this.store.commitBatch({
            source: 'github',
            stream,
            revision,
            previousCursor: cursor,
            ...batch,
          })
        ) {
          if (batch.events.length) this.routing.notify()
          this.checked('github', repo.name)
        }
      } catch (error) {
        if (!this.current(revision)) break
        if (
          error instanceof Error &&
          'retryAfterMs' in error &&
          typeof error.retryAfterMs === 'number' &&
          Number.isFinite(error.retryAfterMs)
        ) {
          this.jobs.github.retryAt = Date.now() + Math.max(1000, error.retryAfterMs)
        }
        this.checked('github', repo.name, error)
      }
    }
    return intervalMs.github
  }

  private async readWxarc({ settings, revision }: TriggerSettingsSnapshot): Promise<number | null> {
    // One upstream feed contains all rooms. Rooms at an equal checkpoint share a request.
    const groups = new Map<string | null, TriggerWxarcSession[]>()
    for (const session of settings.wxarc.sessions.filter((row) => row.enabled)) {
      const cursor = this.store.readCursor(this.key('wxarc', session.id))
      const group = groups.get(cursor)
      if (group) group.push(session)
      else groups.set(cursor, [session])
    }
    if (!groups.size) return null
    let delay = intervalMs.wxarc
    for (const [cursor, sessions] of groups) {
      if (!this.current(revision)) break
      try {
        const batch = await this.connectors.pollWxarc(sessions, cursor, this.controller.signal)
        if (!this.current(revision)) break
        for (const session of sessions) {
          const saved = this.store.commitBatch({
            source: 'wxarc',
            stream: this.key('wxarc', session.id),
            revision,
            previousCursor: cursor,
            cursor: batch.cursor,
            events: batch.events.filter((event) => event.scope === session.id),
          })
          if (saved) {
            if (batch.events.length) this.routing.notify()
            this.checked('wxarc', session.id)
          }
        }
        if (batch.hasMore) delay = 50
      } catch (error) {
        if (!this.current(revision)) break
        for (const session of sessions) this.checked('wxarc', session.id, error)
      }
    }
    return delay
  }

  private checked(source: TriggerSource, scope: string, error?: unknown) {
    this.status.set(this.key(source, scope), {
      source,
      scope,
      state: error ? 'error' : 'watching',
      lastCheckedAt: new Date().toISOString(),
      ...(error ? { error: error instanceof Error ? error.message : '来源检查失败' } : {}),
    })
  }
}
