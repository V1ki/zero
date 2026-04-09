import type { ToolContext, ToolResult } from '@zero-os/shared'
import { BaseTool } from './base'

interface MemoryReadInput {
  path: string
  from?: number
  lines?: number
}

export class MemoryReadTool extends BaseTool {
  name = 'memory_read'
  description =
    '按 path 读取 `.zero/memory/**` 下的记忆文件，可选 from/lines 窗口。memo.md 不在此工具范围内。'
  parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Project-relative or memory-relative path under .zero/memory',
      },
      from: { type: 'number', description: 'Start line (1-indexed)' },
      lines: { type: 'number', description: 'Number of lines to read' },
    },
    required: ['path'],
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const { path, from, lines } = input as MemoryReadInput

    if (!ctx.memoryStore?.readByPath) {
      return {
        success: false,
        output: 'Memory store read access not available',
        outputSummary: 'Memory store read access not configured',
      }
    }

    const result = ctx.memoryStore.readByPath(path, { from, lines })
    if (!result) {
      return {
        success: false,
        output: `Invalid memory path: ${path}`,
        outputSummary: 'Invalid memory path',
      }
    }

    const range =
      from !== undefined || lines !== undefined
        ? `\nRange: from=${Math.max(1, Math.floor(from ?? 1))}${lines !== undefined ? ` lines=${Math.max(0, Math.floor(lines))}` : ''}`
        : ''

    return {
      success: true,
      output: `Path: ${result.path}${range}\n\n${result.text}`,
      outputSummary: result.text
        ? `Read memory file ${result.path}`
        : `Memory file empty or missing: ${result.path}`,
    }
  }
}
