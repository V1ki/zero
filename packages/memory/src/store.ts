import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import {
  ALL_MEMORY_TYPES,
  type Memory,
  type MemoryType,
  generatePrefixedId,
  now,
} from '@zero-os/shared'
import matter from 'gray-matter'

export type MemoryUpdate = Partial<Memory> | ((current: Memory) => Partial<Memory>)

const DEFAULT_CREATE_ID_MAX_ATTEMPTS = 16
const MEMORY_TYPE_DIRS: Record<MemoryType, string> = {
  session: 'sessions',
  incident: 'incidents',
  runbook: 'runbooks',
  decision: 'decisions',
  note: 'notes',
  preference: 'preferences',
  inbox: 'inbox',
}

// update() 中显式传 undefined/null 时，仅这些可选字段视为"移除"；
// 必填字段（content/title/status/confidence/tags/related/id/type/createdAt）一律不可被清除。
const STRIPPABLE_UPDATE_KEYS = new Set<string>([
  'supersededBy',
  'mergedInto',
  'topicKey',
  'sessionId',
  'edges',
  'accessCount',
  'lastAccessedAt',
])

export interface MemoryRepository {
  create(
    type: MemoryType,
    title: string,
    content: string,
    options?: Partial<Memory>,
  ): Promise<Memory>
  save(memory: Memory): Promise<void>
  get(type: MemoryType, id: string): Memory | undefined
  getRelativePath(type: MemoryType, id: string): string
  list(type: MemoryType): Memory[]
  searchByTags(tags: string[], types?: MemoryType[]): Memory[]
  update(
    type: MemoryType,
    id: string,
    updates: MemoryUpdate,
    context?: { sessionId?: string; precondition?: (current: Memory) => boolean },
  ): Promise<Memory | undefined>
  delete(type: MemoryType, id: string): Promise<boolean>
  getAgentPreference(agentName: string): string
  deleteBySessionId(sessionId: string): Promise<number>
  // P3a: 可选的语义近邻查找（仅向量化的实现提供），供活文档折叠治 tag 漂移。
  findSimilar?(
    input: { title: string; content: string; tags: string[] },
    opts?: { topK?: number; candidateIds?: string[]; minScore?: number },
  ): Promise<{ id: string; type: MemoryType; score: number } | undefined>
  readByPath(
    path: string,
    options?: { from?: number; lines?: number },
  ): { path: string; text: string } | undefined
}

interface ResolvedMemoryPath {
  absolutePath: string
  projectRelativePath: string
}

function memoryRelativeTypeDir(type: MemoryType): string {
  return MEMORY_TYPE_DIRS[type]
}

function memoryTypeDir(basePath: string, type: MemoryType): string {
  return join(basePath, memoryRelativeTypeDir(type))
}

function ensureMemoryTypeDir(basePath: string, type: MemoryType): string {
  const dir = memoryTypeDir(basePath, type)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function memoryFilePath(basePath: string, type: MemoryType, id: string): string {
  return join(memoryTypeDir(basePath, type), `${id}.md`)
}

function memoryFileExists(basePath: string, type: MemoryType, id: string): boolean {
  return existsSync(memoryFilePath(basePath, type, id))
}

function memoryProjectRelativePath(type: MemoryType, id: string): string {
  return `.zero/memory/${memoryRelativeTypeDir(type)}/${id}.md`
}

function writeMemoryFile(filePath: string, memory: Memory): void {
  const { content, ...frontmatter } = memory
  // content should always be a string; keep malformed callers from crashing serialization.
  const fileContent = matter.stringify(typeof content === 'string' ? content : '', frontmatter)
  writeFileSync(filePath, fileContent, 'utf-8')
}

function readMemoryFile(filePath: string): Memory | undefined {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const { data, content } = matter(raw)
    const memory: Memory = {
      id: data.id ?? basename(filePath, '.md'),
      type: data.type ?? 'note',
      title: data.title ?? '',
      createdAt: data.createdAt ?? data.created_at ?? now(),
      updatedAt: data.updatedAt ?? data.updated_at ?? now(),
      status: data.status ?? 'draft',
      confidence: data.confidence ?? 0.5,
      tags: data.tags ?? [],
      related: data.related ?? [],
      content: content.trim(),
    }
    if (data.sessionId) memory.sessionId = data.sessionId
    if (typeof data.accessCount === 'number') memory.accessCount = data.accessCount
    if (typeof data.lastAccessedAt === 'string') memory.lastAccessedAt = data.lastAccessedAt
    if (typeof data.topicKey === 'string') memory.topicKey = data.topicKey
    if (typeof data.supersededBy === 'string') memory.supersededBy = data.supersededBy
    if (typeof data.mergedInto === 'string') memory.mergedInto = data.mergedInto
    if (Array.isArray(data.edges)) memory.edges = data.edges
    return memory
  } catch {
    return undefined
  }
}

function resolveMemoryPath(basePath: string, path: string): ResolvedMemoryPath | undefined {
  const trimmed = path.trim().replaceAll('\\', '/')
  if (!trimmed) return undefined

  let relativePath = trimmed
  if (relativePath.startsWith('./')) {
    relativePath = relativePath.slice(2)
  }
  if (relativePath.startsWith('.zero/memory/')) {
    relativePath = relativePath.slice('.zero/memory/'.length)
  } else if (relativePath.startsWith('memory/')) {
    relativePath = relativePath.slice('memory/'.length)
  }

  if (!relativePath || !relativePath.endsWith('.md')) return undefined
  if (relativePath === 'memo.md') return undefined

  const absolutePath = resolve(basePath, relativePath)
  const resolvedBasePath = resolve(basePath)
  if (absolutePath !== resolvedBasePath && !absolutePath.startsWith(`${resolvedBasePath}${sep}`)) {
    return undefined
  }

  const normalizedRelativePath = relative(resolvedBasePath, absolutePath).replaceAll('\\', '/')
  if (!normalizedRelativePath || normalizedRelativePath.startsWith('..')) return undefined
  if (normalizedRelativePath === 'memo.md') return undefined

  return {
    absolutePath,
    projectRelativePath: `.zero/memory/${normalizedRelativePath}`,
  }
}

function readMemoryPath(
  basePath: string,
  path: string,
  options: { from?: number; lines?: number } = {},
): { path: string; text: string } | undefined {
  const resolved = resolveMemoryPath(basePath, path)
  if (!resolved) return undefined

  if (!existsSync(resolved.absolutePath)) {
    return { path: resolved.projectRelativePath, text: '' }
  }

  const content = readFileSync(resolved.absolutePath, 'utf-8')
  if (options.from === undefined && options.lines === undefined) {
    return { path: resolved.projectRelativePath, text: content }
  }

  const from = Math.max(1, Math.floor(options.from ?? 1))
  const lines = options.lines === undefined ? undefined : Math.max(0, Math.floor(options.lines))
  const allLines = content.split('\n')
  const startIndex = from - 1
  const sliced =
    lines === undefined
      ? allLines.slice(startIndex)
      : allLines.slice(startIndex, startIndex + lines)
  return {
    path: resolved.projectRelativePath,
    text: sliced.join('\n'),
  }
}

/**
 * Memory store — CRUD operations for Markdown + Frontmatter memory files.
 */
export class MemoryStore implements MemoryRepository {
  constructor(private basePath: string) {}

  /**
   * Create a new memory entry.
   */
  async create(
    type: MemoryType,
    title: string,
    content: string,
    options?: Partial<Memory>,
  ): Promise<Memory> {
    const { id: requestedId, ...memoryOptions } = options ?? {}
    const { id, release } = allocateMemoryCreateId({
      basePath: this.basePath,
      requestedId,
    })
    const timestamp = now()
    try {
      // create 允许 caller 显式提供 createdAt/updatedAt（import/migration 需保留原始时间戳）；
      // 对异常时间戳的防护下沉到 recency 评分（NaN→最旧），不在此处强制 now()。
      const memory: Memory = {
        id,
        type,
        title,
        createdAt: timestamp,
        updatedAt: timestamp,
        status: 'draft',
        confidence: 0.5,
        tags: [],
        related: [],
        content,
        ...memoryOptions,
      }

      await this.save(memory)
      return memory
    } finally {
      release()
    }
  }

  /**
   * Save a memory to disk as Markdown + Frontmatter.
   */
  async save(memory: Memory): Promise<void> {
    if (hasConflictingMemoryId(this.basePath, memory.id, memory.type)) {
      throw new Error(`Memory id already exists in another type: ${memory.id}`)
    }

    ensureMemoryTypeDir(this.basePath, memory.type)
    writeMemoryFile(memoryFilePath(this.basePath, memory.type, memory.id), memory)
  }

  /**
   * Read a memory by ID and type.
   */
  get(type: MemoryType, id: string): Memory | undefined {
    const filePath = memoryFilePath(this.basePath, type, id)
    if (!existsSync(filePath)) return undefined
    return readMemoryFile(filePath)
  }

  /**
   * Resolve a project-relative path for a stored memory file.
   */
  getRelativePath(type: MemoryType, id: string): string {
    return memoryProjectRelativePath(type, id)
  }

  /**
   * List all memories of a given type.
   */
  list(type: MemoryType): Memory[] {
    const dir = memoryTypeDir(this.basePath, type)
    if (!existsSync(dir)) return []

    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => readMemoryFile(join(dir, f)))
      .filter((m): m is Memory => m !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * Search memories by tags.
   */
  searchByTags(tags: string[], types?: MemoryType[]): Memory[] {
    const targetTypes = types ?? ALL_MEMORY_TYPES
    const results: Memory[] = []

    for (const type of targetTypes) {
      const memories = this.list(type)
      for (const memory of memories) {
        if (tags.some((tag) => memory.tags.includes(tag))) {
          results.push(memory)
        }
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence)
  }

  /**
   * Update a memory's metadata.
   */
  async update(
    type: MemoryType,
    id: string,
    updates: MemoryUpdate,
    _context?: { sessionId?: string; precondition?: (current: Memory) => boolean },
  ): Promise<Memory | undefined> {
    const memory = this.get(type, id)
    if (!memory) return undefined

    // 提交时活性复检（commit-time）：get→precondition→save 之间无 await，相对其他写入原子。
    // 折叠场景用它在落盘前复查目标仍活——堵住 route() 判活到 update 落盘的 TOCTOU 窗口
    // （期间被并发 archive/supersede 会让新内容写进死文档成孤儿，对抗实测确认）。不满足则中止，
    // 由调用方降级为 create。
    if (_context?.precondition && !_context.precondition(memory)) return undefined

    const result = applyMemoryUpdate(memory, updates)
    await this.save(result)
    return result
  }

  /**
   * Delete a memory file.
   */
  async delete(type: MemoryType, id: string): Promise<boolean> {
    const filePath = memoryFilePath(this.basePath, type, id)
    if (!existsSync(filePath)) return false
    unlinkSync(filePath)
    return true
  }

  /**
   * Read an agent-specific preference from preferences/agents/{agentName}.md.
   * Returns only the content (no frontmatter), or empty string if not found.
   */
  getAgentPreference(agentName: string): string {
    const filePath = join(memoryTypeDir(this.basePath, 'preference'), 'agents', `${agentName}.md`)
    if (!existsSync(filePath)) return ''
    const parsed = readMemoryFile(filePath)
    return parsed?.content ?? ''
  }

  /**
   * Delete all memory files associated with a session.
   */
  async deleteBySessionId(sessionId: string): Promise<number> {
    const allTypes = ALL_MEMORY_TYPES
    let deleted = 0

    for (const type of allTypes) {
      const dir = memoryTypeDir(this.basePath, type)
      if (!existsSync(dir)) continue

      for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.md'))) {
        const filePath = join(dir, file)
        const memory = readMemoryFile(filePath)
        if (memory?.sessionId === sessionId) {
          unlinkSync(filePath)
          deleted++
        }
      }
    }

    return deleted
  }

  /**
   * Read a memory file via a project-relative or memory-relative path.
   * Returns empty text for missing files and undefined for invalid paths.
   */
  readByPath(
    path: string,
    options: { from?: number; lines?: number } = {},
  ): { path: string; text: string } | undefined {
    return readMemoryPath(this.basePath, path, options)
  }
}

function allocateMemoryCreateId({
  basePath,
  requestedId,
  maxAttempts = DEFAULT_CREATE_ID_MAX_ATTEMPTS,
}: {
  basePath: string
  requestedId?: string
  maxAttempts?: number
}): { id: string; release: () => void } {
  if (requestedId) {
    const release = tryReserveMemoryCreateId(basePath, requestedId)
    if (!release) {
      throw new Error(`Memory id already exists: ${requestedId}`)
    }
    return { id: requestedId, release }
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = generatePrefixedId('mem')
    const release = tryReserveMemoryCreateId(basePath, id)
    if (release) {
      return { id, release }
    }
  }

  throw new Error('Unable to allocate unique memory id')
}

function hasConflictingMemoryId(basePath: string, id: string, currentType: MemoryType): boolean {
  return ALL_MEMORY_TYPES.some(
    (type) => type !== currentType && memoryFileExists(basePath, type, id),
  )
}

function tryReserveMemoryCreateId(basePath: string, id: string): (() => void) | undefined {
  const lockDir = join(basePath, '.id-locks')
  mkdirSync(lockDir, { recursive: true })
  const lockPath = join(lockDir, `${id}.lock`)

  try {
    writeFileSync(lockPath, '', { flag: 'wx' })
  } catch {
    return undefined
  }

  if (hasAnyMemoryId(basePath, id)) {
    unlinkSync(lockPath)
    return undefined
  }

  return () => {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath)
    }
  }
}

function hasAnyMemoryId(basePath: string, id: string): boolean {
  return ALL_MEMORY_TYPES.some((type) => memoryFileExists(basePath, type, id))
}

function applyMemoryUpdate(memory: Memory, updates: MemoryUpdate): Memory {
  // 函数式更新：在同一原子 get→save 临界区内基于【最新】快照计算补丁，让并发 read-modify-write
  // （如多次 resolveConflict 往同一 winner.related 追加）正确叠加而非后写覆盖前写（对抗实测）。
  const patch = typeof updates === 'function' ? updates(memory) : updates

  // 显式传 undefined/null：仅可选谱系/元字段视为"移除"（verify 清谱系指针走此通道）；
  // 必填字段（content/title/status...）的 undefined/null 一律忽略、保留原值，
  // 否则会把正文清成空导致序列化崩溃（对抗实测：工具/PUT 误传 content:null 崩溃整个 update）。
  const updated = { ...memory } as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) {
      if (STRIPPABLE_UPDATE_KEYS.has(key)) delete updated[key]
      continue
    }
    updated[key] = value
  }
  updated.id = memory.id
  updated.type = memory.type
  updated.createdAt = memory.createdAt
  updated.updatedAt = now()

  return updated as unknown as Memory
}
