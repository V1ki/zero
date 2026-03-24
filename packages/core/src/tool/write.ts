import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { withLock } from '@zero-os/shared'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { BaseTool } from './base'

interface WriteInput {
  path: string
  content: string
}

export class WriteTool extends BaseTool {
  kind = 'built-in' as const
  name = 'write'
  description = 'Write content to a file. Creates directories if needed.'
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  }

  protected async execute(_ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const { path, content } = input as WriteInput

    return withLock(path, async () => {
      const dir = dirname(path)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      writeFileSync(path, content, 'utf-8')

      return {
        success: true,
        output: `Written ${content.length} bytes to ${path}`,
        outputSummary: `Wrote ${path}`,
        artifacts: [path],
      }
    })
  }
}
