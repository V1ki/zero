import {
  ALL_MEMORY_TYPES,
  type MemoryType,
  type ToolContext,
  type ToolResult,
  clampConfidence,
  isMemoryStatus,
} from '@zero-os/shared'
import { isActiveFoldTarget } from '../session/live-doc'
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

interface MemorySearchInput {
  query: string
  maxResults?: number
}

interface MemoryReadInput {
  path: string
  from?: number
  lines?: number
}

const LIVE_DOC_SEP = '\n\n---\n\n'
const DEFAULT_SEARCH_TYPES = ALL_MEMORY_TYPES

// P3a: 有界 section append —— 新写入作为新小节追加；超字符上界则丢最旧小节，防活文档无限膨胀。
// 去重按"小节级全等"（不用 includes 子串判定，避免短句误吞）；单节自身超界时硬截断兜底。
function mergeLiveDocContent(existing: string, incoming: string, maxChars: number): string {
  const inc = incoming.trim()
  const ex = existing.trim()
  const existingParts = ex ? ex.split(LIVE_DOC_SEP) : []
  if (!inc || existingParts.some((p) => p.trim() === inc)) return ex
  let parts = existingParts.concat(inc)
  let merged = parts.join(LIVE_DOC_SEP)
  while (parts.length > 1 && merged.length > maxChars) {
    parts = parts.slice(1)
    merged = parts.join(LIVE_DOC_SEP)
  }
  if (merged.length > maxChars) merged = merged.slice(0, maxChars)
  return merged
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
        description:
          'Memory type (required for create/list; optional for update/delete when id is enough)',
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
        const tagList = tags ?? []
        // P3a: 会话内活文档折叠 —— 命中同主题则改走 update（合并正文），不新增。
        // 折叠是 best-effort：路由（含向量查询）失败一律降级为正常 create，绝不阻断写入。
        const folded = await ctx.liveDocHandle
          ?.route({ type, title, content, tags: tagList })
          .catch(() => undefined)
        if (folded) {
          const mergedContent = mergeLiveDocContent(
            folded.existingContent,
            content,
            folded.maxChars,
          )
          const mergedTags = Array.from(new Set([...folded.existingTags, ...tagList]))
          const updated = await ctx.memoryStore.update(
            type,
            folded.memoryId,
            { content: mergedContent, tags: mergedTags },
            // precondition：落盘前复查目标仍活，堵 route()→update 的 TOCTOU 窗口
            // （期间被并发 archive/supersede 则中止折叠，降级为下方 create，避免写进死文档）。
            { sessionId: ctx.sessionId, precondition: isActiveFoldTarget },
          )
          if (updated) {
            return {
              success: true,
              output: `Memory folded into live-doc: ${updated.id} (${updated.type}) "${updated.title}"`,
              outputSummary: `Updated live-doc: ${updated.title}`,
            }
          }
          // 活文档已不存在（被删/归档清理）或落盘前被并发归档/取代 → 落到正常 create。
        }
        const memory = await ctx.memoryStore.create(type, title, content, {
          status: 'verified',
          confidence: 0.85,
          tags: tagList,
          sessionId: ctx.sessionId,
        })
        ctx.liveDocHandle?.register({ type, title, tags: tagList }, memory.id)
        return {
          success: true,
          output: `Memory created: ${memory.id} (${memory.type}) "${memory.title}"`,
          outputSummary: `Created memory: ${memory.title}`,
        }
      }

      case 'update': {
        if (!id) {
          return {
            success: false,
            output: 'update requires id',
            outputSummary: 'Missing id for update',
          }
        }
        const resolvedType = this.resolveTypeById(ctx, id, type)
        if (!resolvedType.success) {
          return resolvedType.result
        }
        // 工具 update 仅允许安全字段；谱系(supersededBy/mergedInto)/edges/topicKey 是系统管理的
        // 图结构，不经 agent 自由写入（对抗实测：工具直传可写坏谱系）。status 做枚举校验。
        const raw = (updates ?? {}) as Record<string, unknown>
        const safeUpdates: Record<string, unknown> = {}
        if (typeof raw.title === 'string') safeUpdates.title = raw.title
        if (typeof raw.content === 'string') safeUpdates.content = raw.content
        if (Array.isArray(raw.tags) && raw.tags.every((t) => typeof t === 'string')) {
          safeUpdates.tags = raw.tags
        }
        const clampedConfidence = clampConfidence(raw.confidence)
        if (clampedConfidence !== undefined) safeUpdates.confidence = clampedConfidence
        if (isMemoryStatus(raw.status)) safeUpdates.status = raw.status
        const updated = await ctx.memoryStore.update(resolvedType.type, id, safeUpdates, {
          sessionId: ctx.sessionId,
        })
        if (!updated) {
          return {
            success: false,
            output: `Memory not found: ${resolvedType.type}/${id}`,
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
        if (!id) {
          return {
            success: false,
            output: 'delete requires id',
            outputSummary: 'Missing id for delete',
          }
        }
        const resolvedType = this.resolveTypeById(ctx, id, type)
        if (!resolvedType.success) {
          return resolvedType.result
        }
        const deleted = await ctx.memoryStore.delete(resolvedType.type, id)
        return {
          success: deleted,
          output: deleted
            ? `Memory deleted: ${resolvedType.type}/${id}`
            : `Memory not found: ${resolvedType.type}/${id}`,
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

  private resolveTypeById(
    ctx: ToolContext,
    id: string,
    type?: MemoryType,
  ): { success: true; type: MemoryType } | { success: false; result: ToolResult } {
    if (type) {
      return { success: true, type }
    }

    const matches = ALL_MEMORY_TYPES.filter((candidate) => ctx.memoryStore?.get(candidate, id))
    if (matches.length === 1) {
      return { success: true, type: matches[0] }
    }

    if (matches.length === 0) {
      return {
        success: false,
        result: {
          success: false,
          output: `Memory not found: ${id}`,
          outputSummary: 'Memory not found',
        },
      }
    }

    return {
      success: false,
      result: {
        success: false,
        output: `Multiple memories found for id "${id}"; provide type explicitly`,
        outputSummary: 'Ambiguous memory id',
      },
    }
  }
}

export class MemorySearchTool extends BaseTool {
  name = 'memory_search'
  description =
    '搜索 `.zero/memory/**` 中的相关记忆片段。回答过往工作、决策、偏好、待办前优先使用。'
  parameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query for relevant memories' },
      maxResults: { type: 'number', description: 'Maximum results to return' },
    },
    required: ['query'],
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const { query, maxResults } = input as MemorySearchInput

    if (!ctx.memoryRetriever) {
      return {
        success: false,
        output: 'Memory retriever not available',
        outputSummary: 'Memory retriever not configured',
      }
    }

    const results = ctx.memoryRetriever.retrieveScored
      ? await ctx.memoryRetriever.retrieveScored(query, {
          topN: maxResults ?? 5,
          types: DEFAULT_SEARCH_TYPES,
          confidenceThreshold: 0,
          sessionId: ctx.sessionId,
        })
      : (
          await ctx.memoryRetriever.retrieve(query, {
            topN: maxResults ?? 5,
            types: DEFAULT_SEARCH_TYPES,
            confidenceThreshold: 0,
            sessionId: ctx.sessionId,
          })
        ).map((memory) => ({
          memory,
          score: 0,
          scoreBreakdown: {
            keyword: 0,
            recency: 0,
          },
        }))

    if (results.length === 0) {
      return {
        success: true,
        output: `No relevant memories found for query: ${query}`,
        outputSummary: 'No relevant memories found',
      }
    }

    const output = results
      .map((entry, index) => {
        const path =
          ctx.memoryStore?.getRelativePath?.(entry.memory.type, entry.memory.id) ??
          `${entry.memory.type}/${entry.memory.id}`
        const snippet = truncateSnippet(entry.memory.content)
        return [
          `${index + 1}. [${entry.memory.type}] ${entry.memory.title}`,
          `   id: ${entry.memory.id}`,
          `   path: ${path}`,
          `   score: ${formatScore(entry.score)} (${formatScoreBreakdown(entry.scoreBreakdown)})`,
          `   age: ${formatAge(entry.memory.updatedAt)}`,
          `   snippet: ${snippet}`,
        ].join('\n')
      })
      .join('\n\n')

    return {
      success: true,
      output,
      outputSummary: `Found ${results.length} relevant memories`,
    }
  }
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

    // S2 使用反馈:主动 memory_read 是最强的"被使用"行为证据,记 read。
    // 非记忆文件(如 preferences/agents/*.md)的 stem 会留下惰性条目,score 查不到即无影响。
    const fileName = result.path.split('/').pop() ?? ''
    const memoryId = fileName.endsWith('.md') ? fileName.slice(0, -3) : ''
    if (memoryId) ctx.memoryUsage?.record(memoryId, 'read', ctx.sessionId)

    return {
      success: true,
      output: `Path: ${result.path}${range}\n\n${result.text}`,
      outputSummary: result.text
        ? `Read memory file ${result.path}`
        : `Memory file empty or missing: ${result.path}`,
    }
  }
}

function truncateSnippet(content: string, maxLength = 240): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

function formatScore(value: number): string {
  return value.toFixed(2)
}

function formatScoreBreakdown(breakdown: {
  keyword: number
  recency: number
  vector?: number
  usage?: number
  gate?: number
}): string {
  const parts = []
  if (breakdown.gate !== undefined) {
    parts.push(`gate: ${formatScore(breakdown.gate)}`)
  }
  if (breakdown.vector !== undefined) {
    parts.push(`vector: ${formatScore(breakdown.vector)}`)
  }
  parts.push(`keyword: ${formatScore(breakdown.keyword)}`)
  parts.push(`recency: ${formatScore(breakdown.recency)}`)
  if (breakdown.usage !== undefined) {
    parts.push(`usage: ${formatScore(breakdown.usage)}`)
  }
  return parts.join(', ')
}

function formatAge(updatedAt: string): string {
  const diffMs = Date.now() - new Date(updatedAt).getTime()
  if (!Number.isFinite(diffMs) || diffMs <= 0) return '0m'

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`

  return `${Math.floor(days / 30)}mo`
}
