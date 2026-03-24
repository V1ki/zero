import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { withLock } from '@zero-os/shared'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { BaseTool } from './base'

interface EditInput {
  path: string
  oldText: string
  newText: string
}

export class EditTool extends BaseTool {
  kind = 'built-in' as const
  name = 'edit'
  description = 'Replace exact text in a file. The old_text must match exactly.'
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      oldText: { type: 'string', description: 'Exact text to find and replace' },
      newText: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'oldText', 'newText'],
  }

  protected async execute(_ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const { path, oldText, newText } = input as EditInput

    if (!existsSync(path)) {
      return { success: false, output: `File not found: ${path}`, outputSummary: 'File not found' }
    }

    return withLock(path, async () => {
      const content = readFileSync(path, 'utf-8')

      if (!content.includes(oldText)) {
        return {
          success: false,
          output: `Text not found in ${path}`,
          outputSummary: 'Text not found',
        }
      }

      const updated = content.replace(oldText, newText)
      writeFileSync(path, updated, 'utf-8')

      return {
        success: true,
        output: `Replaced text in ${path}`,
        outputSummary: `Edited ${path}`,
        artifacts: [path],
      }
    })
  }
}
