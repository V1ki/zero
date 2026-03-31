import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
    updates: Partial<Memory>,
    context?: { sessionId?: string },
  ): Promise<Memory | undefined>
  delete(type: MemoryType, id: string): Promise<boolean>
  getAgentPreference(agentName: string): string
  deleteBySessionId(sessionId: string): Promise<number>
  readByPath(
    path: string,
    options?: { from?: number; lines?: number },
  ): { path: string; text: string } | undefined
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
    const timestamp = now()
    const memory: Memory = {
      id: generatePrefixedId('mem'),
      type,
      title,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'draft',
      confidence: 0.5,
      tags: [],
      related: [],
      content,
      ...options,
    }

    await this.save(memory)
    return memory
  }

  /**
   * Save a memory to disk as Markdown + Frontmatter.
   */
  async save(memory: Memory): Promise<void> {
    const dir = this.typeDir(memory.type)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const filePath = join(dir, `${memory.id}.md`)
    const { content, ...frontmatter } = memory
    const fileContent = matter.stringify(content, frontmatter)
    writeFileSync(filePath, fileContent, 'utf-8')
  }

  /**
   * Read a memory by ID and type.
   */
  get(type: MemoryType, id: string): Memory | undefined {
    const filePath = join(this.typeDir(type), `${id}.md`)
    if (!existsSync(filePath)) return undefined
    return this.parseFile(filePath)
  }

  /**
   * Resolve a project-relative path for a stored memory file.
   */
  getRelativePath(type: MemoryType, id: string): string {
    return `.zero/memory/${this.relativeTypeDir(type)}/${id}.md`
  }

  /**
   * List all memories of a given type.
   */
  list(type: MemoryType): Memory[] {
    const dir = this.typeDir(type)
    if (!existsSync(dir)) return []

    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => this.parseFile(join(dir, f)))
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
    updates: Partial<Memory>,
    _context?: { sessionId?: string },
  ): Promise<Memory | undefined> {
    const memory = this.get(type, id)
    if (!memory) return undefined

    const updated: Memory = {
      ...memory,
      ...updates,
      id: memory.id,
      type: memory.type,
      createdAt: memory.createdAt,
      updatedAt: now(),
    }

    await this.save(updated)
    return updated
  }

  /**
   * Delete a memory file.
   */
  async delete(type: MemoryType, id: string): Promise<boolean> {
    const filePath = join(this.typeDir(type), `${id}.md`)
    if (!existsSync(filePath)) return false
    unlinkSync(filePath)
    return true
  }

  /**
   * Read an agent-specific preference from preferences/agents/{agentName}.md.
   * Returns only the content (no frontmatter), or empty string if not found.
   */
  getAgentPreference(agentName: string): string {
    const filePath = join(this.typeDir('preference'), 'agents', `${agentName}.md`)
    if (!existsSync(filePath)) return ''
    const parsed = this.parseFile(filePath)
    return parsed?.content ?? ''
  }

  /**
   * Delete all memory files associated with a session.
   */
  async deleteBySessionId(sessionId: string): Promise<number> {
    const allTypes = ALL_MEMORY_TYPES
    let deleted = 0

    for (const type of allTypes) {
      const dir = this.typeDir(type)
      if (!existsSync(dir)) continue

      for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.md'))) {
        const filePath = join(dir, file)
        const memory = this.parseFile(filePath)
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
    const resolved = this.resolveMemoryPath(path)
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

  private typeDir(type: MemoryType): string {
    return join(this.basePath, this.relativeTypeDir(type))
  }

  private relativeTypeDir(type: MemoryType): string {
    const dirMap: Record<MemoryType, string> = {
      session: 'sessions',
      incident: 'incidents',
      runbook: 'runbooks',
      decision: 'decisions',
      note: 'notes',
      preference: 'preferences',
      inbox: 'inbox',
    }
    return dirMap[type]
  }

  private resolveMemoryPath(
    path: string,
  ): { absolutePath: string; projectRelativePath: string } | undefined {
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

    const absolutePath = resolve(this.basePath, relativePath)
    const basePath = resolve(this.basePath)
    if (absolutePath !== basePath && !absolutePath.startsWith(`${basePath}${sep}`)) {
      return undefined
    }

    const normalizedRelativePath = relative(basePath, absolutePath).replaceAll('\\', '/')
    if (!normalizedRelativePath || normalizedRelativePath.startsWith('..')) return undefined
    if (normalizedRelativePath === 'memo.md') return undefined

    return {
      absolutePath,
      projectRelativePath: `.zero/memory/${normalizedRelativePath}`,
    }
  }

  private parseFile(filePath: string): Memory | undefined {
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
      return memory
    } catch {
      return undefined
    }
  }
}
