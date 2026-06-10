import type { Memory, MemoryType } from '@zero-os/shared'
import type { MemoryRepository } from './store'

/**
 * Memory lifecycle manager — handles write, organize, archive, and conflict resolution.
 */
export class MemoryLifecycle {
  constructor(private store: MemoryRepository) {}

  /**
   * Create a session memory from a completed session.
   */
  async createSessionMemory(sessionId: string, summary: string, tags: string[]): Promise<Memory> {
    return this.store.create('session', `Session ${sessionId}`, summary, {
      sessionId,
      tags,
      status: 'verified',
      confidence: 0.8,
    })
  }

  /**
   * Create an incident record from a failure event.
   */
  async createIncident(
    title: string,
    description: string,
    sessionId: string,
    tags: string[],
  ): Promise<Memory> {
    return this.store.create('incident', title, description, {
      sessionId,
      tags: ['incident', ...tags],
      status: 'draft',
      confidence: 0.7,
    })
  }

  /**
   * Verify a memory (mark as verified with high confidence).
   */
  async verify(type: MemoryType, id: string, confidence?: number): Promise<Memory | undefined> {
    // 清谱系指针，与 HTTP /verify 端点一致——一条被确认为活权威的记忆不应再指向"更新的"条，
    // 否则留下 verified+supersededBy 僵尸态，检索会把它重定向到别处（召回错乱）。
    return this.store.update(type, id, {
      status: 'verified',
      confidence: confidence ?? 0.9,
      supersededBy: undefined,
      mergedInto: undefined,
    })
  }

  /**
   * Archive old or low-value memories.
   */
  async archiveOld(type: MemoryType, olderThanDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString()
    const memories = this.store.list(type)
    // 仍被其他条 supersededBy/mergedInto 指向的 id 是活权威——绝不能因 updatedAt 老化被归档，
    // 否则命中被取代条沿谱系重定向到的目标会被 status 门槛丢弃（整条谱系召回坍塌）。
    // 注：updatedAt 受折叠刷新污染，稳定权威条反而"显老"，故此守卫尤为必要（对抗实测）。
    const referenced = new Set<string>()
    for (const mem of memories) {
      if (mem.supersededBy) referenced.add(mem.supersededBy)
      if (mem.mergedInto) referenced.add(mem.mergedInto)
    }
    let archived = 0

    for (const mem of memories) {
      if (mem.updatedAt < cutoff && mem.status !== 'archived' && !referenced.has(mem.id)) {
        await this.store.update(type, mem.id, { status: 'archived' })
        archived++
      }
    }

    return archived
  }

  // 沿 supersededBy/mergedInto 链解析到活权威（visited 终止）；与 retrieval.resolveAuthority、
  // supersede 端点路径压缩同一权威模型，避免把已被取代的旧条当作裁决对象。
  private resolveAuthority(type: MemoryType, memory: Memory): Memory {
    let current = memory
    const visited = new Set<string>([memory.id])
    while (true) {
      const nextId = current.supersededBy ?? current.mergedInto
      if (!nextId || visited.has(nextId)) break
      const next = this.store.get(type, nextId)
      if (!next) break
      visited.add(nextId)
      current = next
    }
    return current
  }

  /**
   * Resolve conflicts between two memories.
   * Higher confidence wins; if equal, more recent wins.
   */
  async resolveConflict(type: MemoryType, id1: string, id2: string): Promise<Memory | undefined> {
    const m1 = this.store.get(type, id1)
    const m2 = this.store.get(type, id2)
    if (!m1 || !m2) return undefined

    // 先解析到各自活权威，避免把已被取代的旧条选成 winner（对抗实测：裸 confidence 选 winner
    // 会留 archived 当权威、把唯一活权威归档 → 召回坍塌）。同谱系则无需裁决。
    const a1 = this.resolveAuthority(type, m1)
    const a2 = this.resolveAuthority(type, m2)
    if (a1.id === a2.id) return a1

    const winner =
      a1.confidence !== a2.confidence
        ? a1.confidence > a2.confidence
          ? a1
          : a2
        : a1.updatedAt > a2.updatedAt
          ? a1
          : a2
    const loser = winner.id === a1.id ? a2 : a1

    // loser 归档并指向 winner —— 命中 loser 的检索沿谱系重定向到 winner（与 /supersede 一致）。
    await this.store.update(type, loser.id, { status: 'archived', supersededBy: winner.id })

    // winner 强制为活权威态：清自身谱系指针、若被归档则复活，并记录关联。
    const related = winner.related.includes(loser.id)
      ? winner.related
      : [...winner.related, loser.id]
    return this.store.update(type, winner.id, {
      related,
      status: winner.status === 'archived' ? 'verified' : winner.status,
      supersededBy: undefined,
      mergedInto: undefined,
    })
  }
}
