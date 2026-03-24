import { existsSync, readFileSync } from 'node:fs'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { BaseTool } from './base'

interface ReadInput {
  path: string
  offset?: number
  limit?: number
}

export class ReadTool extends BaseTool {
  kind = 'built-in' as const
  name = 'read'
  description = 'Read file contents. Supports optional line offset and limit.'
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
      offset: { type: 'number', description: 'Line offset (0-indexed)' },
      limit: { type: 'number', description: 'Maximum lines to return' },
    },
    required: ['path'],
  }

  protected async execute(_ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const { path, offset, limit } = input as ReadInput

    if (!existsSync(path)) {
      return { success: false, output: `File not found: ${path}`, outputSummary: 'File not found' }
    }

    const content = readFileSync(path, 'utf-8')
    let lines = content.split('\n')

    if (offset !== undefined) {
      lines = lines.slice(offset)
    }
    if (limit !== undefined) {
      lines = lines.slice(0, limit)
    }

    const output = lines.join('\n')
    return {
      success: true,
      output,
      outputSummary: `Read ${lines.length} lines from ${path}`,
    }
  }
}
