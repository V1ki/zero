/**
 * Browser driver interface for benchmark comparison.
 * Each driver wraps a browser automation tool (agent-browser, pinchtab-cli, pinchtab-http)
 * and exposes a uniform API for scenario execution.
 */

export interface DriverResult {
  success: boolean
  output: string
  duration_ms: number
  error?: string
}

export interface SnapshotOptions {
  interactive?: boolean
  compact?: boolean
  diff?: boolean
  format?: 'json' | 'text'
}

export interface BrowserDriver {
  /** Driver identifier: 'agent-browser' | 'pinchtab-cli' | 'pinchtab-http' */
  readonly name: string

  /** Start the browser service / connect to CDP */
  startup(): Promise<void>

  /** Shut down the browser service / disconnect */
  shutdown(): Promise<void>

  /** Health check — is the service running? */
  health(): Promise<DriverResult>

  /** Navigate to a URL */
  navigate(url: string, opts?: { wait?: string; newTab?: boolean }): Promise<DriverResult>

  /** Get accessibility snapshot */
  snapshot(opts?: SnapshotOptions): Promise<DriverResult>

  /** Extract readable page text (token-efficient) */
  text(opts?: { mode?: 'readability' | 'raw' }): Promise<DriverResult>

  /** Click an element by ref */
  click(ref: string): Promise<DriverResult>

  /** Fill an input element */
  fill(ref: string, value: string): Promise<DriverResult>

  /** Press a key on an element */
  press(ref: string, key: string): Promise<DriverResult>

  /** Select a dropdown option */
  select(ref: string, value: string): Promise<DriverResult>

  /** Hover over an element */
  hover(ref: string): Promise<DriverResult>

  /** Execute JavaScript and return result */
  evalJS(expression: string): Promise<DriverResult>

  /** Take a screenshot */
  screenshot(path?: string): Promise<DriverResult>
}

/**
 * Run a CLI command via Bun.spawn and return a DriverResult with timing.
 */
export async function runCLI(args: string[], timeout = 30_000): Promise<DriverResult> {
  const start = performance.now()

  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })

  const timeoutId = setTimeout(() => proc.kill(), timeout)
  const exitCode = await proc.exited
  clearTimeout(timeoutId)

  const PIPE_GRACE_MS = 1000
  const stdout = await Promise.race([
    new Response(proc.stdout).text(),
    Bun.sleep(PIPE_GRACE_MS).then(() => ''),
  ])
  const stderr = await Promise.race([
    new Response(proc.stderr).text(),
    Bun.sleep(PIPE_GRACE_MS).then(() => ''),
  ])

  const duration_ms = Math.round(performance.now() - start)
  const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '')

  if (exitCode !== 0) {
    return {
      success: false,
      output: output || `Exit code: ${exitCode}`,
      duration_ms,
      error: `Process exited with code ${exitCode}`,
    }
  }

  return { success: true, output, duration_ms }
}

/**
 * Run an HTTP request and return a DriverResult with timing.
 */
export async function runHTTP(
  url: string,
  opts?: { method?: string; body?: unknown; timeout?: number },
): Promise<DriverResult> {
  const start = performance.now()
  const timeout = opts?.timeout ?? 30_000

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  const fetchOpts: RequestInit = {
    method: opts?.method ?? 'GET',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json' },
  }

  if (opts?.body) {
    fetchOpts.body = JSON.stringify(opts.body)
  }

  try {
    const response = await fetch(url, fetchOpts)
    clearTimeout(timeoutId)
    const duration_ms = Math.round(performance.now() - start)
    const text = await response.text()

    if (!response.ok) {
      return {
        success: false,
        output: text,
        duration_ms,
        error: `HTTP ${response.status}`,
      }
    }

    return { success: true, output: text, duration_ms }
  } catch (err) {
    clearTimeout(timeoutId)
    const duration_ms = Math.round(performance.now() - start)
    const message = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      output: '',
      duration_ms,
      error: message,
    }
  }
}

/**
 * Estimate token count from text (rough approximation: chars / 4).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
