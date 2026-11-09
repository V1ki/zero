import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { OutputSecretFilter } from '@zero-os/secrets'

const require = createRequire(import.meta.url)
const RPC_TIMEOUT_MS = 60_000
const STEER_TIMEOUT_MS = 10_000
const MAX_LATE_THREAD_REQUESTS = 256
const STDERR_LIMIT = 4096
const MAX_FRAME_BYTES = 64 * 1024 * 1024

type RpcObject = Record<string, unknown>

/** A negative acknowledgement from app-server, as distinct from losing the connection. */
export class CodexAppServerRequestError extends Error {
  constructor(
    message: string,
    readonly codexErrorInfo?: unknown,
  ) {
    super(message)
  }
}

interface ClientOptions {
  cwd: string
  env: Record<string, string>
  codexPath?: string
  codexCommand?: [string, ...string[]]
  onNotification: (method: string, params: RpcObject) => void
  /** A timed-out start or resume may still subscribe this connection to a thread. */
  onLateResult?: (method: string, result: RpcObject, expectedResumeThreadId?: string) => void
  onLateResumeRejected?: (threadId: string) => void
  filterDiagnostic?: (text: string) => string
}

function isObject(value: unknown): value is RpcObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// This tool runs unattended. Answer server-initiated requests without granting access.
function serverReply(method: string): RpcObject {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'decline' } }
    case 'item/permissions/requestApproval':
      return { result: { permissions: {}, scope: 'turn' } }
    case 'item/tool/requestUserInput':
      return { result: { answers: {} } }
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline', content: null, _meta: null } }
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { result: { decision: 'abort' } }
    case 'item/tool/call':
      return { result: { success: false, contentItems: [] } }
    default:
      return { error: { code: -32601, message: 'Server request is not supported by this worker' } }
  }
}

/** A shared stdio connection. Request IDs are scoped to each direction and never reused. */
export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly disconnect = Promise.withResolvers<Error>()
  readonly closed = this.disconnect.promise
  private readonly exited = Promise.withResolvers<void>()
  private readonly pending = new Map<number, PromiseWithResolvers<RpcObject>>()
  private readonly lateThreadRequests = new Map<
    number,
    { method: string; expectedResumeThreadId?: string }
  >()
  private nextId = 1
  private failure?: Error
  private closing?: Promise<void>
  private stderr: string | undefined = ''
  private readonly secrets: OutputSecretFilter

  constructor(private readonly options: ClientOptions) {
    const args = [...(options.codexCommand?.slice(1) ?? []), 'app-server', '--listen', 'stdio://']
    if (!options.codexCommand && !options.codexPath)
      args.unshift(require.resolve('@openai/codex/bin/codex.js'))
    this.secrets = new OutputSecretFilter(
      Object.entries(options.env).filter(([name]) =>
        /key|token|secret|password|credential|auth/i.test(name),
      ),
    )
    this.child = spawn(options.codexCommand?.[0] ?? options.codexPath ?? process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    this.child.once('error', (error) => this.fail(error))
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (this.stderr !== undefined) {
        this.stderr =
          this.stderr.length + chunk.length <= STDERR_LIMIT ? this.stderr + chunk : undefined
      }
    })
    this.child.stderr.on('error', (error) => this.fail(error))
    // Decode incrementally so a corrupt peer cannot buffer an unbounded JSONL frame.
    const fragments: string[] = []
    let frameBytes = 0
    this.child.stdout.on('error', (error) => this.fail(error))
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (this.failure) return
      try {
        const parts = chunk.split('\n')
        for (const [index, part] of parts.entries()) {
          frameBytes += Buffer.byteLength(part)
          if (frameBytes > MAX_FRAME_BYTES) throw new Error('Codex app-server frame exceeds 64 MiB')
          if (part) fragments.push(part)
          if (index < parts.length - 1) {
            this.receive(fragments.join(''))
            fragments.length = 0
            frameBytes = 0
          }
        }
      } catch (error) {
        fragments.length = 0
        this.fail(error instanceof Error ? error : new Error('Codex app-server protocol error'))
      }
    })
    this.child.once('close', (code, signal) => {
      this.exited.resolve()
      const detail = this.stderr?.trim()
      this.fail(
        new Error(`Codex app-server exited (${signal ?? code})${detail ? `: ${detail}` : ''}`),
      )
    })
    // 'close' normally follows both pipe EOF and launcher exit after all messages drain.
    // A broken pipe or a crashed launcher with a surviving native child may never emit it.
    const expectClose = () => {
      const timer = setTimeout(() => this.fail(new Error('Codex app-server disconnected')), 100)
      void this.exited.promise.then(() => clearTimeout(timer))
    }
    this.child.stdout.once('end', expectClose)
    this.child.once('exit', expectClose)
  }

  async request(
    method: string,
    params: RpcObject,
    options: { timeoutMs?: number } = {},
  ): Promise<RpcObject> {
    if (this.failure) throw this.failure
    const id = this.nextId++
    const reply = Promise.withResolvers<RpcObject>()
    this.pending.set(id, reply)
    const expectedResumeThreadId =
      method === 'thread/resume' && typeof params.threadId === 'string'
        ? params.threadId
        : undefined
    const timeoutMs =
      options.timeoutMs ?? (method === 'turn/steer' ? STEER_TIMEOUT_MS : RPC_TIMEOUT_MS)
    const timeout = setTimeout(() => {
      this.pending.delete(id)
      if (method === 'thread/start' || expectedResumeThreadId !== undefined) {
        if (this.lateThreadRequests.size >= MAX_LATE_THREAD_REQUESTS) {
          const oldest = this.lateThreadRequests.keys().next()
          if (!oldest.done) this.lateThreadRequests.delete(oldest.value)
        }
        this.lateThreadRequests.set(id, { method, expectedResumeThreadId })
      }
      reply.reject(new Error(`Codex app-server timed out acknowledging ${method}`))
    }, timeoutMs)
    try {
      this.write({ id, method, params })
      return await reply.promise
    } finally {
      this.pending.delete(id)
      clearTimeout(timeout)
    }
  }

  notify(method: string, params: RpcObject): void {
    if (this.failure) throw this.failure
    this.write({ method, params })
  }

  private write(message: RpcObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      throw new Error('Invalid JSON from Codex app-server')
    }
    if (!isObject(frame)) throw new Error('Invalid message from Codex app-server')
    if (typeof frame.method === 'string') {
      if (frame.id === undefined) {
        if (!isObject(frame.params)) throw new Error('Invalid Codex notification parameters')
        this.options.onNotification(frame.method, frame.params)
      } else {
        if (typeof frame.id !== 'number' && typeof frame.id !== 'string')
          throw new Error('Invalid Codex server request ID')
        this.write({ id: frame.id, ...serverReply(frame.method) })
      }
      return
    }
    const id = frame.id
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id >= this.nextId) {
      throw new Error('Unexpected Codex app-server response ID')
    }
    const reply = this.pending.get(id)
    const late = this.lateThreadRequests.get(id)
    this.lateThreadRequests.delete(id)
    if (isObject(frame.error) && typeof frame.error.message === 'string' && !('result' in frame)) {
      if (late?.expectedResumeThreadId !== undefined) {
        this.options.onLateResumeRejected?.(late.expectedResumeThreadId)
      }
      reply?.reject(
        new CodexAppServerRequestError(
          this.redact(frame.error.message),
          isObject(frame.error.data) ? frame.error.data.codexErrorInfo : undefined,
        ),
      )
    } else if (isObject(frame.result) && !('error' in frame)) {
      if (late) this.options.onLateResult?.(late.method, frame.result, late.expectedResumeThreadId)
      reply?.resolve(frame.result)
    } else {
      throw new Error('Invalid response from Codex app-server')
    }
    this.pending.delete(id)
  }

  private redact(message: string): string {
    const filtered = this.secrets.filter(message).replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
    return this.options.filterDiagnostic?.(filtered) ?? filtered
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = new Error(this.redact(error.message))
    this.disconnect.resolve(this.failure)
    for (const reply of this.pending.values()) reply.reject(this.failure)
    this.pending.clear()
    this.lateThreadRequests.clear()
    // close() retains its rejection for the owner awaiting cleanup in finally.
    void this.close().catch(() => {})
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closing = this.stop()
      this.fail(new Error('Codex app-server connection closed'))
    }
    return this.closing
  }

  private async stop(): Promise<void> {
    this.child.stdin.end()
    // EOF normally exits both the published JS launcher and its native child.
    // Escalate the owned process group together if a stuck turn prevents shutdown.
    let signalFailure = ''
    const signal = (kind: NodeJS.Signals) => {
      void this.signalTree(kind).catch((error: Error) => {
        signalFailure = this.redact(error.message)
      })
    }
    const term = setTimeout(() => signal('SIGTERM'), 500)
    const kill = setTimeout(() => signal('SIGKILL'), 1500)
    const cleanup = Promise.withResolvers<never>()
    const deadline = setTimeout(() => {
      cleanup.reject(
        new Error(`Unable to reap Codex app-server process: ${signalFailure || 'timed out'}`),
      )
    }, 5000)
    try {
      await Promise.race([this.exited.promise, cleanup.promise])
    } finally {
      clearTimeout(term)
      clearTimeout(kill)
      clearTimeout(deadline)
    }
  }

  private async signalTree(signal: NodeJS.Signals): Promise<void> {
    const pid = this.child.pid
    if (!pid) return
    if (process.platform === 'win32') {
      // Windows does not implement negative-PID process groups.
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      await new Promise<void>((resolve, reject) => {
        killer.once('error', reject)
        killer.once('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`taskkill exited (${code})`)),
        )
      })
      return
    }
    try {
      process.kill(-pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}
