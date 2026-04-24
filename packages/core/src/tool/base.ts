import type { ToolContext, ToolDefinition, ToolKind, ToolResult } from '@zero-os/shared'
import { now, toErrorMessage } from '@zero-os/shared'

/**
 * Abstract base class for all ZeRo OS tools.
 */
export abstract class BaseTool {
  kind: ToolKind = 'tool'
  abstract name: string
  abstract description: string
  abstract parameters: Record<string, unknown>

  /**
   * Fuse check - override in tools that execute commands (e.g., Bash).
   */
  protected async fuseCheck(_input: unknown): Promise<void> {}

  /**
   * Pre-execution hook - acquire locks, etc.
   */
  protected async beforeExecute(_ctx: ToolContext, _input: unknown): Promise<void> {}

  /**
   * The actual tool execution logic.
   */
  protected abstract execute(ctx: ToolContext, input: unknown): Promise<ToolResult>

  /**
   * Post-execution hook - release locks, write logs, filter secrets.
   */
  protected async afterExecute(
    ctx: ToolContext,
    result: ToolResult,
    durationMs: number,
  ): Promise<void> {
    // Filter secrets from output
    if (ctx.secretFilter) {
      const secretFilter = ctx.secretFilter
      result.output = secretFilter.filter(result.output)
      result.outputSummary = secretFilter.filter(result.outputSummary)
      result.contentItems = result.contentItems?.map((item) =>
        item.type === 'text' ? { ...item, text: secretFilter.filter(item.text) } : item,
      )
    }

    ctx.logger.info('tool_call_complete', {
      tool: this.name,
      success: result.success,
      outputSummary: result.outputSummary,
      durationMs,
    })

    // Tool executions still contribute to metrics, but not to events.jsonl.
    if (ctx.observability) {
      ctx.observability.recordOperation({
        sessionId: ctx.sessionId,
        tool: this.name,
        event: 'tool_call_complete',
        success: result.success,
        durationMs,
        createdAt: now(),
      })
    }
  }

  /**
   * Public entry point - the only method callers should use.
   */
  async run(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const startTime = Date.now()
    try {
      // Validate required fields from tool schema
      this.validateRequiredFields(input)
      await this.fuseCheck(input)
      await this.beforeExecute(ctx, input)
      const result = await this.execute(ctx, input)
      const durationMs = Date.now() - startTime
      await this.afterExecute(ctx, result, durationMs)
      return result
    } catch (error) {
      const errorMessage = toErrorMessage(error)
      const durationMs = Date.now() - startTime
      const result: ToolResult = {
        success: false,
        output: errorMessage,
        outputSummary: `Error: ${errorMessage.slice(0, 100)}`,
      }
      ctx.logger.error('tool_call_error', {
        tool: this.name,
        error: errorMessage,
        durationMs,
      })
      return result
    }
  }

  /**
   * Validate that all required fields from the tool's parameters schema exist in the input.
   */
  private validateRequiredFields(input: unknown): void {
    const required = (this.parameters as Record<string, unknown>).required
    if (!Array.isArray(required) || required.length === 0) return
    if (!input || typeof input !== 'object') {
      throw new Error(
        `Tool "${this.name}" requires fields [${required.join(', ')}] but received ${input === null ? 'null' : typeof input}`,
      )
    }
    const obj = input as Record<string, unknown>
    const missing = required.filter(
      (field: string) => obj[field] === undefined || obj[field] === null,
    )
    if (missing.length > 0) {
      throw new Error(
        `Tool "${this.name}" missing required fields: [${missing.join(', ')}]. Input may have been truncated by max_tokens.`,
      )
    }
  }

  /**
   * Get tool definition for LLM tool use.
   */
  toDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      kind: this.kind,
    }
  }
}
