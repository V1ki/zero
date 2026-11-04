import type { SecretFilter } from '@zero-os/shared'
import { buildCodexServerEnv } from '../process-env'
import { CodexAppServerClient } from './app-server-client'

type Fields = Record<string, unknown>
type ServerOptions = { codexPath?: string; secretFilter?: SecretFilter; experimentalApi?: boolean }
interface ThreadListener {
  notify(method: string, params: Fields): void
  fail(error: Error): void
  lateResume?(accepted: boolean): void
}

/** One initialized connection. All thread reservations belong to this process generation. */
export class CodexWorkerConnection {
  private readonly client: CodexAppServerClient
  private readonly threads = new Map<string, ThreadListener>()
  private failure?: Error
  readonly ready: Promise<void>

  constructor(options: ServerOptions) {
    this.client = new CodexAppServerClient({
      cwd: process.cwd(),
      env: buildCodexServerEnv(),
      codexPath: options.codexPath,
      filterDiagnostic: options.secretFilter?.filter.bind(options.secretFilter),
      onNotification: (method, params) => {
        const listener = typeof params.threadId === 'string' && this.threads.get(params.threadId)
        if (!listener) return
        try {
          listener.notify(method, params)
        } catch (error) {
          listener.fail(error instanceof Error ? error : new Error('Invalid Codex thread event'))
        }
      },
      onLateResult: (method, result, expectedThreadId) => {
        const thread = result.thread
        if (
          !thread ||
          typeof thread !== 'object' ||
          !('id' in thread) ||
          typeof thread.id !== 'string'
        )
          return
        const threadId = thread.id
        if (method === 'thread/resume' && threadId === expectedThreadId) {
          this.threads.get(threadId)?.lateResume?.(true)
        }
        // A timed-out start can still create and subscribe to an idle thread.
        if (!this.threads.has(threadId) && !this.failure) this.releaseOrphan(threadId)
      },
      onLateResumeRejected: (threadId) => this.threads.get(threadId)?.lateResume?.(false),
    })
    void this.client.closed.then((error) => {
      this.failure = error
      for (const listener of this.threads.values()) listener.fail(error)
      this.threads.clear()
    })
    this.ready = this.initialize(options.experimentalApi)
  }

  private releaseOrphan(threadId: string): void {
    const release = this.listen(
      threadId,
      (method) => {
        if (method === 'thread/closed') release()
      },
      () => {},
    )
    // If removal is unconfirmed, retain the reservation until thread/closed or disconnect.
    void this.unsubscribe(threadId).then(release, (error: Error) => process.emitWarning(error))
  }

  private async initialize(experimentalApi?: boolean): Promise<void> {
    try {
      await this.client.request('initialize', {
        clientInfo: { name: 'zero_os_worker', version: '1' },
        ...(experimentalApi && { capabilities: { experimentalApi: true } }),
      })
      this.client.notify('initialized', {})
    } catch (error) {
      await this.close()
      throw error
    }
  }

  get disconnected(): boolean {
    return this.failure !== undefined
  }

  request(method: string, params: Fields): Promise<Fields> {
    return this.client.request(method, params)
  }

  async unsubscribe(threadId: string): Promise<void> {
    const { status } = await this.request('thread/unsubscribe', { threadId })
    if (status !== 'unsubscribed' && status !== 'notSubscribed' && status !== 'notLoaded') {
      throw new Error('Invalid Codex app-server unsubscribe acknowledgement')
    }
  }

  listen(
    threadId: string,
    notify: ThreadListener['notify'],
    fail: ThreadListener['fail'],
    lateResume?: ThreadListener['lateResume'],
  ): () => void {
    if (this.failure) throw this.failure
    if (this.threads.has(threadId))
      throw new Error(`Codex thread already has an active worker: ${threadId}`)
    const listener = { notify, fail, lateResume }
    this.threads.set(threadId, listener)
    return () => {
      if (this.threads.get(threadId) === listener) this.threads.delete(threadId)
    }
  }

  close(): Promise<void> {
    this.failure ??= new Error('Codex app-server connection closed')
    return this.client.close()
  }
}

/** Owned by the runtime's registered WorkerTool. Spawn lazily, including after a crash. */
export class CodexWorkerServer {
  private current?: CodexWorkerConnection
  private stopped = false

  constructor(private readonly options: ServerOptions = {}) {}

  async acquire(): Promise<CodexWorkerConnection> {
    const previous = this.current
    if (previous?.disconnected) {
      await previous.close()
      if (this.current === previous) this.current = undefined
    }
    if (this.stopped) throw new Error('Codex worker server has shut down')
    this.current ??= new CodexWorkerConnection(this.options)
    const connection = this.current
    await connection.ready
    return connection
  }

  async close(): Promise<void> {
    this.stopped = true
    await this.current?.close()
  }
}
