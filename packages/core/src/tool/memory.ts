import {
  ALL_MEMORY_TYPES,
  type MemoryType,
  type ToolContext,
  type ToolResult,
} from '@zero-os/shared'
import { BaseTool } from './base'

type MemoryAction = 'create' | 'update' | 'delete' | 'list'

interface MemoryInput {
  action: MemoryAction
  type?: MemoryType
  title?: string
  content?: string
  tags?: string[]
  id?: string
  updates?: Record<string, unknown>
}

/**
 * MemoryTool — create, update, delete, or list memories.
 */
export class MemoryTool extends BaseTool {
  name = 'memory'
  description =
    '显式创建、更新、删除或列出记忆。用于“记住/更新/删除”这类写入维护操作，不用于 recall。用户偏好用 preference 类型，架构决策用 decision 类型。'
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'update', 'delete', 'list'],
        description: 'The operation to perform',
      },
      type: {
        type: 'string',
        enum: ALL_MEMORY_TYPES,
        description: 'Memory type',
      },
      title: { type: 'string', description: 'Memory title (required for create)' },
      content: { type: 'string', description: 'Memory content in Markdown (required for create)' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags for categorization',
      },
      id: { type: 'string', description: 'Memory ID (required for update/delete)' },
      updates: {
        type: 'object',
        description: 'Fields to update: title, content, tags, status, confidence',
      },
    },
    required: ['action'],
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const { action, type, title, content, tags, id, updates } = input as MemoryInput

    if (!ctx.memoryStore) {
      return {
        success: false,
        output: 'Memory store not available',
        outputSummary: 'Memory store not configured',
      }
    }

    switch (action) {
      case 'create': {
        if (!type || !title || !content) {
          return {
            success: false,
            output: 'create requires type, title, and content',
            outputSummary: 'Missing required fields for create',
          }
        }
        const memory = await ctx.memoryStore.create(type, title, content, {
          status: 'verified',
          confidence: 0.85,
          tags: tags ?? [],
          sessionId: ctx.sessionId,
        })
        return {
          success: true,
          output: `Memory created: ${memory.id} (${memory.type}) "${memory.title}"`,
          outputSummary: `Created memory: ${memory.title}`,
        }
      }

      case 'update': {
        if (!type || !id) {
          return {
            success: false,
            output: 'update requires type and id',
            outputSummary: 'Missing type or id for update',
          }
        }
        const updated = await ctx.memoryStore.update(type, id, updates ?? {}, {
          sessionId: ctx.sessionId,
        })
        if (!updated) {
          return {
            success: false,
            output: `Memory not found: ${type}/${id}`,
            outputSummary: 'Memory not found',
          }
        }
        return {
          success: true,
          output: `Memory updated: ${updated.id}`,
          outputSummary: `Updated memory ${updated.id}`,
        }
      }

      case 'delete': {
        if (!type || !id) {
          return {
            success: false,
            output: 'delete requires type and id',
            outputSummary: 'Missing type or id for delete',
          }
        }
        const deleted = await ctx.memoryStore.delete(type, id)
        return {
          success: deleted,
          output: deleted ? `Memory deleted: ${type}/${id}` : `Memory not found: ${type}/${id}`,
          outputSummary: deleted ? `Deleted ${id}` : 'Memory not found',
        }
      }

      case 'list': {
        if (!type) {
          return {
            success: false,
            output: 'list requires type',
            outputSummary: 'Missing type for list',
          }
        }
        const memories = ctx.memoryStore.list(type)
        const summary = memories
          .map((m) => `- [${m.id}] ${m.title} (${m.status}, tags: ${m.tags.join(', ')})`)
          .join('\n')
        return {
          success: true,
          output: memories.length > 0 ? summary : `No memories of type "${type}"`,
          outputSummary: `Listed ${memories.length} ${type} memories`,
        }
      }

      default:
        return {
          success: false,
          output: `Unknown action: ${action}`,
          outputSummary: `Unknown action: ${action}`,
        }
    }
  }
}
