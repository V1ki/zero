import type { MemoryType, ToolContext } from '@zero-os/shared'
import { CONTEXT_PARAMS } from '../agent/params'

// 活文档只能折进"仍活跃"的文档：已归档/已被取代/已并入的文档不再是有效折叠目标，
// 否则会话中途被治理归档后，同主题新写入会被静默埋进检索不可见的归档文档（数据黑洞）。
export function isActiveFoldTarget(m: {
  status: string
  supersededBy?: string
  mergedInto?: string
}): boolean {
  return m.status !== 'archived' && !m.supersededBy && !m.mergedInto
}

// P3a: 活文档折叠键 —— 同 type + tags 归一化（归一化后为空时退化为 title slug，
// 避免全空白 tags 产生 "type|" 这种跨主题碰撞键）。
export function deriveLiveDocKey(type: MemoryType, title: string, tags: string[]): string {
  const normalized = tags
    .map((t) => t.toLowerCase().trim())
    .filter(Boolean)
    .sort()
  const tagKey = normalized.length
    ? normalized.join(',')
    : title.toLowerCase().replace(/\s+/g, ' ').trim()
  return `${type}|${tagKey}`
}

/**
 * P3a: 构建会话级活文档折叠句柄。Session 持有 liveDocs（内存态，不持久化），
 * memory 工具 create 经 route 命中同主题则改走 update 合并。
 * 抽成独立工厂以便测试覆盖真实链路（而非在测试里复刻逻辑）。
 */
export function createLiveDocHandle(
  liveDocs: Map<string, string>,
  memoryStore: ToolContext['memoryStore'] | undefined,
): NonNullable<ToolContext['liveDocHandle']> {
  return {
    route: async (input: { type: MemoryType; title: string; content: string; tags: string[] }) => {
      const key = deriveLiveDocKey(input.type, input.title, input.tags)
      const existingId = liveDocs.get(key)
      if (existingId) {
        const existing = memoryStore?.get(input.type, existingId)
        if (existing && isActiveFoldTarget(existing)) {
          return {
            memoryId: existingId,
            existingContent: existing.content,
            existingTags: existing.tags,
            maxChars: CONTEXT_PARAMS.memory.liveDocMaxChars,
          }
        }
        // 不存在或已归档/取代 → 弃用陈旧指针，落到新建
        liveDocs.delete(key)
      }
      // tag-key 未命中 → 向量相似度兜底（治 tag 漂移；实测 tag 键仅消除 1%，向量才是主力）。
      // 候选限同 type：跨 type 匹配后 memory.ts 用 input type 去 update 必然 miss，白付 embedding。
      if (CONTEXT_PARAMS.memory.liveDocVectorEnabled && memoryStore?.findSimilar) {
        const typePrefix = `${input.type}|`
        const sessionDocIds = [
          ...new Set(
            [...liveDocs.entries()].filter(([k]) => k.startsWith(typePrefix)).map(([, id]) => id),
          ),
        ]
        if (sessionDocIds.length > 0) {
          const match = await memoryStore.findSimilar(
            { title: input.title, content: input.content, tags: input.tags },
            {
              candidateIds: sessionDocIds,
              minScore: CONTEXT_PARAMS.memory.liveDocSimThreshold,
            },
          )
          const existing = match ? memoryStore.get(match.type, match.id) : undefined
          if (match && existing && isActiveFoldTarget(existing)) {
            liveDocs.set(key, match.id)
            return {
              memoryId: match.id,
              existingContent: existing.content,
              existingTags: existing.tags,
              maxChars: CONTEXT_PARAMS.memory.liveDocMaxChars,
            }
          }
        }
      }
      return undefined
    },
    register: (input: { type: MemoryType; title: string; tags: string[] }, memoryId: string) => {
      liveDocs.set(deriveLiveDocKey(input.type, input.title, input.tags), memoryId)
    },
  }
}
