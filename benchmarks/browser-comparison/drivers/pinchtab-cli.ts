/**
 * PinchTab CLI driver.
 * Wraps `pinchtab` CLI commands via Bun.spawn.
 */

import type { BrowserDriver, DriverResult, SnapshotOptions } from './base'
import { runCLI } from './base'

export class PinchTabCLIDriver implements BrowserDriver {
  readonly name = 'pinchtab-cli'

  async startup(): Promise<void> {
    const result = await this.health()
    if (!result.success) {
      throw new Error(
        `pinchtab: Server not available on port 9867. Start with: pinchtab\n${result.error}`,
      )
    }
  }

  async shutdown(): Promise<void> {
    // PinchTab server runs persistently; no per-session shutdown needed
  }

  async health(): Promise<DriverResult> {
    return runCLI(['curl', '-sf', 'http://localhost:9867/health'], 5000)
  }

  async navigate(url: string, opts?: { wait?: string; newTab?: boolean }): Promise<DriverResult> {
    const args = ['pinchtab', 'nav', url]
    if (opts?.newTab) args.push('--new-tab')
    return runCLI(args)
  }

  async snapshot(opts?: SnapshotOptions): Promise<DriverResult> {
    const args = ['pinchtab', 'snap']
    if (opts?.interactive) args.push('-i')
    if (opts?.compact) args.push('-c')
    if (opts?.diff) args.push('--diff')
    if (opts?.format === 'text') args.push('--format', 'text')
    return runCLI(args)
  }

  async text(opts?: { mode?: 'readability' | 'raw' }): Promise<DriverResult> {
    const args = ['pinchtab', 'text']
    if (opts?.mode === 'raw') args.push('--mode', 'raw')
    return runCLI(args)
  }

  async click(ref: string): Promise<DriverResult> {
    return runCLI(['pinchtab', 'click', ref])
  }

  async fill(ref: string, value: string): Promise<DriverResult> {
    return runCLI(['pinchtab', 'fill', ref, value])
  }

  async press(ref: string, key: string): Promise<DriverResult> {
    return runCLI(['pinchtab', 'press', ref, key])
  }

  async select(ref: string, value: string): Promise<DriverResult> {
    return runCLI(['pinchtab', 'select', ref, value])
  }

  async hover(ref: string): Promise<DriverResult> {
    return runCLI(['pinchtab', 'hover', ref])
  }

  async evalJS(expression: string): Promise<DriverResult> {
    return runCLI(['pinchtab', 'eval', expression])
  }

  async screenshot(path?: string): Promise<DriverResult> {
    const args = ['pinchtab', 'screenshot']
    if (path) args.push('--raw')
    return runCLI(args)
  }
}
