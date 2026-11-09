import { assetId, evidenceKey, hash } from './extraction'
import type { Asset, CategoryGroup, Evidence, Project, QualityCorrection } from './types'

export function verifyCorrectionChain(project: Project) {
  let previous: string | null = null
  for (const record of project.qualityCorrections ?? []) {
    const { id, ...body } = record
    if (
      body.previous !== previous ||
      id !== hash(JSON.stringify(body)) ||
      body.sourceSha256 !== project.sourceSha256 ||
      body.provenance !== 'source-review' ||
      !body.reviewer.trim() ||
      body.reason.trim().length < 4 ||
      !body.evidence.length
    )
      throw new Error('更正审计链无效')
    previous = id
  }
}
export function verifyCorrectionSource(project: Project, source: string) {
  verifyCorrectionChain(project)
  if (hash(source) !== project.sourceSha256) throw new Error('更正source hash不一致')
  const check = (e: Evidence, mention = false) => {
    const ch = project.chapters.find((c) => c.id === e.chapterId)
    const chunk = project.chunks.find((c) => c.id === e.chunkId)
    if (
      !ch ||
      !chunk ||
      chunk.chapterId !== ch.id ||
      !Number.isInteger(e.start) ||
      !Number.isInteger(e.end) ||
      e.start < ch.start ||
      e.end > ch.end ||
      e.end <= e.start ||
      e.chapterOffset !== e.start - ch.start ||
      source.slice(e.start, e.end) !== e.quote ||
      (mention && (e.start < chunk.start || e.end > chunk.end || chunk.status !== 'succeeded'))
    )
      throw new Error('更正来源/范围无效')
  }
  for (const c of project.qualityCorrections ?? []) {
    for (const e of c.evidence) check(e)
    if (c.operation.type === 'supplement') {
      const m = c.operation.mention
      check(m.evidence, true)
      if (!m.evidence.quote.includes(m.name) || !['character', 'location', 'prop'].includes(m.kind))
        throw new Error('补充mention名称或类型无效')
    }
  }
}
export function appendCorrection(
  project: Project,
  source: string,
  input: Omit<QualityCorrection, 'id' | 'previous' | 'sourceSha256'>,
) {
  verifyCorrectionSource(project, source)
  const body = {
    ...input,
    previous: project.qualityCorrections?.at(-1)?.id ?? null,
    sourceSha256: project.sourceSha256,
  }
  const c = { id: hash(JSON.stringify(body)), ...body }
  const next = { ...project, qualityCorrections: [...(project.qualityCorrections ?? []), c] }
  verifyCorrectionSource(next, source)
  correctedChunks(next) // reject stale mention addresses before publishing
  project.qualityCorrections = next.qualityCorrections
  return c
}

/** A derived copy only. Never mutate successful raw chunks. */
export function correctedChunks(project: Project) {
  verifyCorrectionChain(project)
  const chunks = structuredClone(project.chunks)
  for (const c of project.qualityCorrections ?? []) {
    const op = c.operation
    if (op.type === 'supplement') {
      const m = op.mention
      const chunk = chunks.find((ch) => ch.id === m.evidence.chunkId)
      if (
        !chunk ||
        chunks.some((ch) =>
          ch.mentions.some(
            (x) =>
              assetId(x.kind, x.name) === assetId(m.kind, m.name) &&
              evidenceKey(x.evidence) === evidenceKey(m.evidence),
          ),
        )
      )
        throw new Error('重复或无效的补充mention')
      chunk.mentions.push(structuredClone(m))
    } else if (op.type === 'retype') {
      const matches = chunks
        .flatMap((ch) => ch.mentions)
        .filter(
          (m) =>
            assetId(m.kind, m.name) === op.fromId && evidenceKey(m.evidence) === op.evidenceKey,
        )
      if (
        matches.length !== 1 ||
        !op.interpretation.trim() ||
        matches[0].kind === op.kind ||
        !['character', 'location', 'prop'].includes(op.kind)
      )
        throw new Error('类型更正地址/解释无效')
      matches[0].kind = op.kind
      matches[0].description += `；类型更正说明：${op.interpretation}`
    }
  }
  return chunks
}
export function retractedCommitIds(project: Project) {
  return new Set(
    (project.qualityCorrections ?? []).flatMap((c) =>
      c.operation.type === 'retract' ? [c.operation.commitId] : [],
    ),
  )
}
export function prohibitedMatch(project: Project, left: string, right: string) {
  return (project.qualityCorrections ?? []).some(
    ({ operation: o }) =>
      o.type === 'distinct' &&
      ((o.leftId === left && o.rightId === right) || (o.rightId === left && o.leftId === right)),
  )
}
export function categoryProjection(project: Project, assets: Asset[]): CategoryGroup[] {
  const used = new Set<string>()
  return (project.qualityCorrections ?? []).flatMap((c) => {
    const op = c.operation
    if (op.type !== 'category') return []
    const members = op.memberIds.map((id) => assets.find((a) => a.id === id))
    if (
      !op.label.trim() ||
      members.length < 2 ||
      members.some((a) => !a) ||
      new Set(op.memberIds).size !== members.length ||
      members.some((a) => a?.kind !== members[0]?.kind) ||
      op.memberIds.some((id) => used.has(id))
    )
      throw new Error('类别成员不存在/跨类型/重复')
    for (const id of op.memberIds) used.add(id)
    return [
      {
        id: `category-${c.id.slice(0, 24)}`,
        label: op.label,
        memberIds: [...op.memberIds],
        correctionId: c.id,
      },
    ]
  })
}
