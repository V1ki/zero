import type { Asset, AssetKind, Evidence, ProjectView } from '../../ip-video/types'

export const kindLabels: Record<AssetKind, string> = {
  character: '人物',
  location: '场景',
  prop: '道具',
}
export const statusLabels: Record<string, string> = {
  ready: '待分析',
  pending: '待处理',
  running: '处理中',
  completed: '已完成',
  succeeded: '成功',
  failed: '失败',
  blocked: '受阻',
  interrupted: '已中断',
  stale: '待重新复核',
}

// A source excerpt, not a newly generated summary. Keep all descriptions on the asset.
export function assetExcerpt(asset: Asset, limit = 120) {
  const text = asset.descriptions.find((item) => item.trim())?.trim() ?? ''
  const characters = Array.from(text)
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : text || '暂无描述'
}

export function filterAssets(assets: Asset[], kind: 'all' | AssetKind, query: string) {
  const normalized = query.trim().normalize('NFKC').toLocaleLowerCase()
  return assets.filter(
    (asset) =>
      (kind === 'all' || asset.kind === kind) &&
      [asset.name, ...asset.aliases].some((value) =>
        value.normalize('NFKC').toLocaleLowerCase().includes(normalized),
      ),
  )
}

export function selectedCanonicalAsset(
  project: Pick<ProjectView, 'assets' | 'identityResolution'>,
  id: string,
) {
  return project.assets.find(
    (asset) => asset.id === (project.identityResolution?.redirects[id] ?? id),
  )
}

export function coveragePercent(project: ProjectView) {
  return project.sourceUtf16Length > 0
    ? Math.min(
        100,
        Math.max(0, Math.floor((100 * project.progress.coveredUtf16) / project.sourceUtf16Length)),
      )
    : 0
}

export function evidenceRange(text: string, evidence: Evidence | null) {
  if (!evidence || evidence.chapterOffset < 0) return null
  const start = evidence.chapterOffset
  const end = start + evidence.quote.length
  // UTF-16 offsets come from the API. Never locate by fuzzy text or change source whitespace.
  return text.slice(start, end) === evidence.quote ? { start, end } : null
}

// Presentation-only grouping. Identity assets and their IDs are never replaced.
export function catalogAssets(
  project: Pick<ProjectView, 'assets' | 'categoryGroups'>,
): (Asset & { memberIds?: string[] })[] {
  const grouped = new Set(project.categoryGroups?.flatMap((g) => g.memberIds) ?? [])
  return [
    ...project.assets.filter((a) => !grouped.has(a.id)),
    ...(project.categoryGroups ?? []).map((g) => {
      const members = g.memberIds.map((id) => {
        const member = project.assets.find((a) => a.id === id)
        if (!member) throw new Error('类别明细丢失')
        return member
      })
      if (!members.length) throw new Error('类别明细丢失')
      return {
        id: g.id,
        name: g.label,
        kind: members[0].kind,
        aliases: members.flatMap((a) => [a.name, ...a.aliases]),
        descriptions: [`创作类别 · ${members.length} 项明细，保留各自身份与原文引用`],
        evidence: members.flatMap((a) => a.evidence),
        memberIds: g.memberIds,
      }
    }),
  ]
}
