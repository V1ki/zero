import { setTimeout as sleep } from 'node:timers/promises'
import type { RouterJob, TriggerStore } from '@zero-os/observe'
import type {
  TriggerGithubPermissionSelection,
  TriggerGithubRepository,
  TriggerSettings,
  TriggerSettingsSnapshot,
  TriggerSource,
  TriggerStatus,
  TriggerWxarcSession,
} from '@zero-os/shared'
import {
  checkGithubReadPermissions,
  getGithubRepository,
  listGithubRepositories,
  pollGithub,
} from './github'
import { type GithubAppAuth, unavailableGithubAppAuth } from './github-app-auth'
import type { TriggerMandateRuntime } from './mandate-runtime'
import type { MandateService } from './mandate-service'
import { type RepositoryWebhookProvider, acceptRepositoryWebhook } from './repository-webhook'
import type { RouterGithubReplies } from './router-github-reply'
import type { RouterWorkspaceService } from './router-workspace'
import type { TriggerRoutingRuntime } from './routing-runtime'
import type { TriggerTaskBridge } from './task-bridge'
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
  private wxarcRequest?: AbortController
  private readonly status = new Map<string, TriggerStatus>()
  private readonly jobs: Record<TriggerSource, SourceJob> = {
    github: { refreshRequested: false, retryAt: 0 },
    wxarc: { refreshRequested: false, retryAt: 0 },
  }
  private retentionTimer?: ReturnType<typeof setTimeout>
  private started = false
  private stopping?: Promise<void>

  constructor(
    private readonly store: TriggerStore,
    private readonly resolveSecret: (ref: string) => string | undefined,
    readonly routing: TriggerRoutingRuntime,
    readonly workspace: RouterWorkspaceService,
    private readonly connectors = { pollGithub, pollWxarc },
    private readonly tasks?: {
      runtime: TriggerMandateRuntime
      mandates: MandateService
      bridge: TriggerTaskBridge
      onGithubIntake?(): void
      mayReadTrackingResult?(job: RouterJob): boolean
    },
    private readonly githubApp: GithubAppAuth = unavailableGithubAppAuth,
    readonly githubReplies?: RouterGithubReplies,
  ) {}

  get mandates() {
    return this.tasks?.mandates
  }

  get taskBridge() {
    return this.tasks?.bridge
  }

  /** The subscription transaction has committed. Start or refresh the shared GitHub listener. */
  refreshGithubTracking() {
    this.request('github', true)
    this.tasks?.onGithubIntake?.()
  }

  private notifyIntake() {
    this.workspace.notifySignals()
    this.tasks?.onGithubIntake?.()
    this.routing.notify()
    this.tasks?.runtime.notify()
  }

  start(): void {
    if (this.started || this.controller.signal.aborted) return
    this.started = true
    this.sweepExpiredContent()
    this.workspace.start()
    if (!this.workspace.ownsIntake) {
      this.routing.start()
      this.tasks?.runtime.start()
    }
    for (const source of sources) this.request(source)
  }

  private sweepExpiredContent() {
    if (this.controller.signal.aborted) return
    let delay = 60 * 60_000
    try {
      if (this.store.retention.sweep().more) delay = 1000
    } catch (error) {
      console.error(
        '[listeners] Router history cleanup failed, retrying in one minute.',
        error instanceof Error ? error.name : 'UnknownError',
      )
      delay = 60_000
    }
    this.retentionTimer = setTimeout(() => this.sweepExpiredContent(), delay)
    this.retentionTimer.unref()
  }

  close(): Promise<void> {
    if (!this.stopping) {
      this.controller.abort()
      clearTimeout(this.retentionTimer)
      for (const job of Object.values(this.jobs)) clearTimeout(job.timer)
      this.stopping = Promise.allSettled([
        this.githubReplies?.close(),
        this.tasks?.bridge.close(),
        this.tasks?.runtime.close(),
        this.workspace.close(),
        this.routing.close(),
        ...sources.map((source) => this.jobs[source].running),
      ]).then(() => this.store.close())
    }
    return this.stopping
  }

  getSettings() {
    return this.store.getSettings()
  }

  saveSettings(
    settings: TriggerSettings,
    revision: number,
    githubLookbackHours?: 1 | 24,
    expectedMandateRevision?: number,
  ) {
    const next = this.store.saveSettings(
      settings,
      revision,
      githubLookbackHours,
      expectedMandateRevision,
    )
    if (next !== revision) {
      this.status.clear()
      this.notifyIntake()
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
      ...settings.github.repositories.map((row) => ({
        ...state('github', row.name, row.enabled),
        lastIgnoredComment: this.store.lastIgnoredComment(this.key('github', row.name)),
      })),
      ...settings.wxarc.sessions.map((row) => state('wxarc', row.id, row.enabled)),
    ]
  }

  listTrackingResults(limit?: number, beforeId?: number) {
    const authorized = this.tasks?.mayReadTrackingResult
    if (!authorized) return []
    const count = Math.max(1, Math.min(100, limit ?? 30))
    const cursor = beforeId ?? Number.MAX_SAFE_INTEGER
    return [
      ...this.store.tracking.listResults(count, cursor, authorized),
      ...this.store.archive.listResults(count, cursor, authorized),
    ]
      .sort((a, b) => b.inboxId - a.inboxId)
      .slice(0, count)
  }

  listInbox(limit?: number, beforeId?: number) {
    return this.store.listInbox(limit, beforeId)
  }

  get webNotifications() {
    return this.store.webNotifications
  }

  async listGithubRepositories(signal: AbortSignal, credentialRef = '', name?: string) {
    const token = await this.githubToken(
      credentialRef,
      name ? this.repository(name) : undefined,
      signal,
    )
    if (name) return [await getGithubRepository(name, token, signal)]
    return listGithubRepositories(token, signal)
  }

  async checkGithubPermissions(
    name: string,
    credentialRef: string,
    selection: TriggerGithubPermissionSelection,
    signal: AbortSignal,
  ) {
    const stop = AbortSignal.any([signal, this.controller.signal])
    return checkGithubReadPermissions(
      name,
      await this.githubToken(credentialRef, this.repository(name), stop),
      selection,
      stop,
    )
  }

  receiveWebhook(provider: RepositoryWebhookProvider, scope: string, request: Request) {
    return acceptRepositoryWebhook(provider, scope, request, {
      store: this.store,
      resolveSecret: this.resolveSecret,
      githubToken: (ref, repo, signal) => this.githubToken(ref, repo, signal),
      githubAppIdentity: this.githubApp.getCommentIdentity?.bind(this.githubApp),
      signal: this.controller.signal,
      accepted: (name, hasEvents) => {
        this.checked('github', name)
        if (hasEvents) this.notifyIntake()
      },
    })
  }

  listWxarcSessions(signal: AbortSignal) {
    return listWxarcSessions(signal)
  }

  async scan(): Promise<void> {
    for (const source of sources) this.request(source)
  }

  private repository(name: string) {
    return this.getSettings().settings.github.repositories.find(
      (repo) => repo.name.toLowerCase() === name.toLowerCase(),
    )
  }

  private githubToken(ref: string, repo: TriggerGithubRepository | undefined, signal: AbortSignal) {
    if (repo?.githubAppRef !== undefined)
      return this.githubApp.getToken(repo.githubAppRef, repo.name, signal)
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
      if (refresh) {
        job.refreshRequested = true
        if (source === 'wxarc') this.wxarcRequest?.abort()
      }
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
    const repos = settings.github.repositories.filter(
      (row) => row.enabled && row.deliveryMode !== 'webhook',
    )
    if (!repos.length) return null
    const signal = this.controller.signal
    for (const repo of repos) {
      if (!this.current(revision) || this.jobs.github.retryAt > Date.now()) break
      const selection = this.store.tracking.pollSelection(repo)
      if (!selection) continue
      const stream = this.key('github', repo.name)
      const cursor = this.store.readCursor(stream)
      const start = this.store.getStreamStartedAt(stream)
      if (!start) continue
      try {
        const token = await this.githubToken(settings.github.credentialRef, repo, signal)
        if (!this.current(revision)) break
        const batch = await this.connectors.pollGithub(
          selection,
          cursor,
          token,
          signal,
          start,
          undefined,
          this.store.tracking.pendingSince(repo.name),
          this.githubApp.getCommentIdentity?.bind(this.githubApp),
        )
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
          if (batch.events.length) this.notifyIntake()
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
    const enabled = settings.wxarc.sessions.filter((room) => room.enabled)
    if (!enabled.length) return null
    const controller = new AbortController()
    this.wxarcRequest = controller
    const signal = AbortSignal.any([this.controller.signal, controller.signal])
    // Each distinct checkpoint is queued once, even while its HTTP request is in flight.
    // Rooms catching up to a waiting request can join it because the feed is global.
    type Group = { cursor: string | null; rooms: TriggerWxarcSession[] }
    const groups = new Map<string | null, Group>()
    const pending: Group[] = []
    const enqueue = (room: TriggerWxarcSession) => {
      const cursor = this.store.readCursor(this.key('wxarc', room.id))
      const existing = groups.get(cursor)
      if (existing) existing.rooms.push(room)
      else {
        const group = { cursor, rooms: [room] }
        groups.set(cursor, group)
        pending.push(group)
      }
    }
    for (const room of enabled) enqueue(room)

    const consume = async () => {
      while (!signal.aborted) {
        const group = pending.shift()
        if (!group) return
        const { cursor, rooms } = group
        const started = Date.now()
        try {
          const batch = await this.connectors.pollWxarc(
            enabled,
            cursor,
            signal,
            undefined,
            (scope) => this.store.archive.recent(scope),
          )
          if (signal.aborted || !this.current(revision)) return
          // A nonconforming source can answer an idle request immediately. Bound reconnects.
          if (batch.cursor === cursor) {
            const delay = 1000 - (Date.now() - started)
            if (delay > 0) await sleep(delay, undefined, { signal })
          }
          if (signal.aborted || !this.current(revision)) return
          let matched = false
          for (const room of rooms) {
            const events = batch.events.filter((event) => event.scope === room.id)
            if (
              this.store.commitBatch({
                source: 'wxarc',
                stream: this.key('wxarc', room.id),
                revision,
                previousCursor: cursor,
                cursor: batch.cursor,
                events,
              })
            ) {
              if (events.length) matched = true
              this.checked('wxarc', room.id)
            }
          }
          if (matched) this.notifyIntake()
        } catch (error) {
          if (signal.aborted || !this.current(revision)) return
          for (const room of rooms) this.checked('wxarc', room.id, error)
          await sleep(intervalMs.wxarc, undefined, { signal })
        }
        groups.delete(cursor)
        // A partial failure or another local reader can advance a subset of rooms.
        for (const room of rooms) enqueue(room)
      }
    }

    const workers = Array.from({ length: Math.min(4, groups.size) }, consume)
    try {
      await Promise.all(workers)
    } catch (error) {
      if (!signal.aborted) throw error
    } finally {
      controller.abort()
      await Promise.allSettled(workers)
      this.wxarcRequest = undefined
    }
    // Settings edited by another process also establish a fresh set of subscriptions.
    return 0
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
