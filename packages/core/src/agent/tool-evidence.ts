import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message, ToolEvidence, ToolEvidenceKind, ToolUseBlock } from '@zero-os/shared'
import { now } from '@zero-os/shared'
import { CONTEXT_PARAMS } from './params'

interface EvidenceWriteInput {
  workDir: string
  sessionId: string
  toolUseId: string
  toolName: string
  kind: ToolEvidenceKind
  payload: string
  summary?: string
  strategy?: string
  extension?: 'json' | 'txt'
}

const runtimeArtifactsDir = '.artifacts'
const evidenceBaseDir = 'tool-evidence'

export function shouldPersistToolInput(input: Record<string, unknown>): boolean {
  return stableStringify(input).length > CONTEXT_PARAMS.toolOutput.artifactThresholdChars
}

export function persistToolEvidence(input: EvidenceWriteInput): ToolEvidence {
  const sha256 = createHash('sha256').update(input.payload).digest('hex')
  const safeTool = sanitizePathPart(input.toolName)
  const safeUseId = sanitizePathPart(input.toolUseId)
  const ext = input.extension ?? (input.kind === 'tool_use_input' ? 'json' : 'txt')
  const dir = join(input.workDir, runtimeArtifactsDir, input.sessionId, evidenceBaseDir)
  mkdirSync(dir, { recursive: true })

  const filename = `${safeUseId}-${input.kind}-${safeTool}-${sha256.slice(0, 12)}.${ext}`
  const path = join(dir, filename)
  const alreadyExists = existsSync(path)
  if (!alreadyExists) {
    writeFileSync(path, input.payload, 'utf-8')
  }

  return {
    kind: input.kind,
    sessionId: input.sessionId,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    path,
    chars: input.payload.length,
    bytes: Buffer.byteLength(input.payload, 'utf-8'),
    sha256,
    createdAt: now(),
    summary: input.summary,
    strategy: input.strategy,
    writeStatus: alreadyExists ? 'existing' : 'created',
  }
}

export function persistToolInputEvidence(params: {
  workDir: string
  sessionId: string
  toolUse: ToolUseBlock
}): ToolEvidence {
  const payload = stableStringify(params.toolUse.input)
  const summary = summarizeToolInput(params.toolUse.name, params.toolUse.input)
  return persistToolEvidence({
    workDir: params.workDir,
    sessionId: params.sessionId,
    toolUseId: params.toolUse.id,
    toolName: params.toolUse.name,
    kind: 'tool_use_input',
    payload,
    summary: summary.summary,
    strategy: summary.strategy,
    extension: 'json',
  })
}

export function persistToolResultEvidence(params: {
  workDir: string
  sessionId: string
  toolUseId: string
  toolName: string
  content: string
  outputSummary?: string
}): ToolEvidence {
  const summary = summarizeToolResult(params.toolName, params.content, params.outputSummary)
  return persistToolEvidence({
    workDir: params.workDir,
    sessionId: params.sessionId,
    toolUseId: params.toolUseId,
    toolName: params.toolName,
    kind: 'tool_result_output',
    payload: params.content,
    summary,
    strategy: `${params.toolName.toLowerCase()}_result`,
    extension: 'txt',
  })
}

export function attachLargeToolUseEvidence(
  content: Message['content'],
  options: {
    workDir: string
    sessionId: string
    onEvidence?: (evidence: ToolEvidence, toolUse: ToolUseBlock) => void
  },
): Message['content'] {
  return content.map((block) => {
    if (block.type !== 'tool_use') return block
    if (block.evidence || !shouldPersistToolInput(block.input)) return block
    const evidence = persistToolInputEvidence({
      workDir: options.workDir,
      sessionId: options.sessionId,
      toolUse: block,
    })
    options.onEvidence?.(evidence, block)
    return {
      ...block,
      evidence,
    }
  })
}

export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): { strategy: string; summary: string; scope: string[] } {
  const normalized = toolName.toLowerCase()
  const path = stringValue(input.path) ?? stringValue(input.file_path)

  switch (normalized) {
    case 'read': {
      const range = [stringValue(input.offset), stringValue(input.limit)].filter(Boolean).join(':')
      return {
        strategy: 'read_path_range',
        summary: `read ${path ?? 'unknown path'}${range ? ` range=${range}` : ''}`,
        scope: path ? [path] : [],
      }
    }
    case 'write': {
      const content = stringValue(input.content)
      return {
        strategy: 'write_path_content_size',
        summary: `write ${path ?? 'unknown path'} contentChars=${content?.length ?? 0}`,
        scope: path ? [path] : [],
      }
    }
    case 'edit': {
      const oldText = stringValue(input.old_string) ?? stringValue(input.oldText)
      const newText = stringValue(input.new_string) ?? stringValue(input.newText)
      return {
        strategy: 'edit_path_replacement_size',
        summary: `edit ${path ?? 'unknown path'} oldChars=${oldText?.length ?? 0} newChars=${newText?.length ?? 0}`,
        scope: path ? [path] : [],
      }
    }
    case 'bash': {
      const description = stringValue(input.description)
      const command = stringValue(input.command)
      return {
        strategy: 'bash_description_command_preview',
        summary: `bash ${description ?? command?.replace(/\s+/g, ' ').slice(0, 160) ?? 'command'}`,
        scope: [],
      }
    }
    case 'memory_search': {
      const query = stringValue(input.query)
      return {
        strategy: 'memory_search_query',
        summary: `memory_search query=${query?.slice(0, 180) ?? 'unknown'}`,
        scope: [],
      }
    }
    case 'memory_read': {
      const memoryPath = path ?? stringValue(input.id) ?? stringValue(input.memoryId)
      return {
        strategy: 'memory_read_pointer',
        summary: `memory_read ${memoryPath ?? 'unknown memory'}`,
        scope: memoryPath ? [memoryPath] : [],
      }
    }
    default:
      return {
        strategy: 'generic_tool_input_metadata',
        summary: `${toolName} inputKeys=${Object.keys(input).sort().join(',') || 'none'}`,
        scope: path ? [path] : [],
      }
  }
}

export function summarizeToolResult(
  toolName: string,
  content: string,
  outputSummary?: string,
): string {
  const normalized = toolName.toLowerCase()
  const source =
    outputSummary?.trim() ||
    (content.length > CONTEXT_PARAMS.history.summaryMaxChars
      ? `raw output captured in evidence file; chars=${content.length}`
      : firstUsefulLines(content, normalized === 'bash' ? 4 : 3))

  switch (normalized) {
    case 'write':
      return `write tool output captured: ${truncateOneLine(source || 'write completed', 220)}`
    case 'edit':
      return `edit tool output captured: ${truncateOneLine(source || 'edit completed', 220)}`
    case 'read':
      return `read evidence captured: ${truncateOneLine(source || 'file content captured', 220)}`
    case 'bash':
      return `bash evidence captured: ${truncateOneLine(source || 'command completed', 220)}`
    case 'memory_search':
      return `memory search evidence captured: ${truncateOneLine(source || 'search completed', 220)}`
    case 'memory_read':
      return `memory read evidence captured: ${truncateOneLine(source || 'memory read completed', 220)}`
    default:
      return `tool evidence captured: ${truncateOneLine(source || 'tool completed', 220)}`
  }
}

export function truncateOneLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized
}

function firstUsefulLines(value: string, maxLines: number): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join(' | ')
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2)
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortJson(nestedValue)]),
  )
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'unknown'
}
