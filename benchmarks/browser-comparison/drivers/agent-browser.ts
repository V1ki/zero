/**
 * Agent-Browser CLI driver.
 * Wraps `agent-browser` CLI commands via Bun.spawn.
 */

import type { BrowserDriver, DriverResult, SnapshotOptions } from './base'
import { runCLI } from './base'

export class AgentBrowserDriver implements BrowserDriver {
  readonly name = 'agent-browser'

  async startup(): Promise<void> {
    // agent-browser connects to an existing CDP instance.
    // Ensure Chrome is running with --remote-debugging-port=9222
    const result = await this.health()
    if (!result.success) {
      throw new Error(
        `agent-browser: CDP not available. Start Chrome with --remote-debugging-port=9222.\n${result.error}`,
      )
    }
  }

  async shutdown(): Promise<void> {
    await runCLI(['agent-browser', 'close'], 5000).catch(() => {})
  }

  async health(): Promise<DriverResult> {
    return runCLI(['curl', '-sf', 'http://localhost:9222/json/version'], 5000)
  }

  async navigate(url: string, opts?: { wait?: string }): Promise<DriverResult> {
    const args = ['agent-browser', 'open', url]
    if (opts?.wait) args.push('--wait', opts.wait)
    return runCLI(args)
  }

  async snapshot(opts?: SnapshotOptions): Promise<DriverResult> {
    const args = ['agent-browser', 'snapshot']
    if (opts?.interactive) args.push('-i')
    return runCLI(args)
  }

  async text(): Promise<DriverResult> {
    // agent-browser has no native text command; use eval as fallback
    return this.evalJS('document.body.innerText')
  }

  async click(ref: string): Promise<DriverResult> {
    return runCLI(['agent-browser', 'click', `@${ref}`])
  }

  async fill(ref: string, value: string): Promise<DriverResult> {
    return runCLI(['agent-browser', 'fill', `@${ref}`, value])
  }

  async press(ref: string, key: string): Promise<DriverResult> {
    // agent-browser uses fill + key simulation; approximate with eval
    return runCLI(['agent-browser', 'fill', `@${ref}`, key])
  }

  async select(ref: string, value: string): Promise<DriverResult> {
    return runCLI(['agent-browser', 'select', `@${ref}`, value])
  }

  async hover(ref: string): Promise<DriverResult> {
    return runCLI(['agent-browser', 'hover', `@${ref}`])
  }

  async evalJS(expression: string): Promise<DriverResult> {
    return runCLI(['agent-browser', 'eval', expression])
  }

  async screenshot(path?: string): Promise<DriverResult> {
    const args = ['agent-browser', 'screenshot']
    if (path) args.push('--output', path)
    return runCLI(args)
  }
}
