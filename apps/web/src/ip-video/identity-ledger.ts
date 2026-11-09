import { assetId, evidenceKey, hash, isGenericCharacterName, resolveAssets } from './extraction'
import { correctedChunks, prohibitedMatch, retractedCommitIds } from './quality-corrections'
import type { Asset, EntityResolutionRun, Project } from './types'

export const mentionAddress = (id: string, key: string) => JSON.stringify([id, key])
export const localAssetId = (id: string, key: string) =>
  `asset-${hash(`local:${id}:${key}`).slice(0, 24)}`

// Raw mentions remain immutable. Generic names have a separate identity for each
// extracted occurrence, even when a previous version put them in one name bucket.
export function scopedEntityBase(project: Project) {
  const chunks = correctedChunks(project)
  const base = resolveAssets(chunks, project.identityResolution?.confirmations)
  const localized = new Set(
    (project.qualityCorrections ?? []).flatMap(({ operation: op }) =>
      op.type === 'localize' ? op.evidenceKeys.map((k) => mentionAddress(op.fromId, k)) : [],
    ),
  )
  for (const address of localized) {
    if (
      !base.assets.some((a) =>
        a.evidence.some((e) => mentionAddress(a.id, evidenceKey(e)) === address),
      )
    )
      throw new Error('局部分离地址不存在')
  }
  const humanMembers = new Set(
    base.identityResolution.confirmations.flatMap((c) => [c.fromId, c.canonicalId]),
  )
  const localMentions = new Map<string, Project['chunks'][number]['mentions']>()
  for (const chunk of chunks) {
    if (chunk.status !== 'succeeded') continue
    for (const mention of chunk.mentions) {
      const key = mentionAddress(assetId(mention.kind, mention.name), evidenceKey(mention.evidence))
      localMentions.set(key, [...(localMentions.get(key) ?? []), mention])
    }
  }
  base.assets = base.assets.flatMap((a) => {
    if (
      !a.evidence.some((e) => localized.has(mentionAddress(a.id, evidenceKey(e)))) &&
      (a.kind !== 'character' || !isGenericCharacterName(a.name) || humanMembers.has(a.id))
    )
      return [a]
    return a.evidence.flatMap((e) => {
      if (
        !(a.kind === 'character' && isGenericCharacterName(a.name) && !humanMembers.has(a.id)) &&
        !localized.has(mentionAddress(a.id, evidenceKey(e)))
      )
        return [{ ...a, evidence: [e] }]
      const mentions = localMentions.get(mentionAddress(a.id, evidenceKey(e))) ?? []
      return [
        {
          ...a,
          id: localAssetId(a.id, evidenceKey(e)),
          localIdentity: { legacyId: a.id },
          aliases: [...new Set(mentions.flatMap((m) => m.aliases))].filter(
            (name) => !isGenericCharacterName(name),
          ),
          descriptions: [...new Set(mentions.map((m) => m.description))],
          evidence: [e],
        },
      ]
    })
  })
  return base
}

export function expandSubjectIds(assets: Asset[], ids: string[]) {
  return [
    ...new Set(
      ids.flatMap((id) => {
        const matches = assets.filter((a) => a.id === id || a.localIdentity?.legacyId === id)
        if (!matches.length) throw new Error('消歧对象不在当前项目canonical资产')
        return matches.map((a) => a.id)
      }),
    ),
  ].sort()
}

// Recover only fully verified legacy runs, never the partial decisions of a failed
// whole-book run. Each verified page and every source reference must be covered.
export function retainedCommits(project: Project, assets: Asset[]) {
  const commits = structuredClone(project.identityResolution?.commits ?? [])
  const revoked = retractedCommitIds(project)
  const withdrawn = commits.filter((c) => revoked.has(c.id))
  for (const run of [
    ...(project.identityResolution?.aiHistory ?? []),
    project.identityResolution?.ai,
  ]) {
    if (
      !run ||
      !['completed', 'stale'].includes(run.status) ||
      run.decisions.length !== run.subjectIds.length ||
      run.subjectIds.some((id) => !run.decisions.some((d) => d.fromId === id))
    )
      continue
    for (const d of run.decisions) {
      if (d.outcome !== 'match' || !d.canonicalId) continue
      const sources = assets.filter(
        (a) => a.id === d.fromId || a.localIdentity?.legacyId === d.fromId,
      )
      const target = assets.find((a) => a.id === d.canonicalId)
      if (!target) continue
      for (const from of sources) {
        // A tombstone also blocks legacy-run recovery under a new local ID/hash.
        if (
          withdrawn.some(
            (c) =>
              c.canonicalId === d.canonicalId &&
              (c.fromId === d.fromId || c.fromId === from.localIdentity?.legacyId) &&
              from.evidence.some((e) => c.subjectKeys.includes(evidenceKey(e))),
          )
        )
          continue
        if (from.kind !== target.kind) continue
        const covered = from.evidence.filter((e) =>
          d.evidence.some(
            (c) =>
              c.chapterId === e.chapterId &&
              c.start <= e.start &&
              c.end >= e.end &&
              c.quote.includes(e.quote),
          ),
        )
        if (!covered.length) continue
        const pages = run.attempts.filter(
          (a) =>
            a.subjectId === d.fromId &&
            a.phase === 'verify' &&
            a.status === 'succeeded' &&
            a.verdict?.outcome === 'match' &&
            a.verdict.canonicalId === target.id,
        )
        if (new Set(pages.map((a) => a.page)).size < Math.ceil(covered.length / 8)) continue
        const id = hash(JSON.stringify([run.version, run.snapshot, from.id, d.canonicalId]))
        if (commits.some((c) => c.id === id)) continue
        commits.push({
          id,
          fromId: from.id,
          canonicalId: target.id,
          sourceSha256: project.sourceSha256,
          subjectKeys: covered.map(evidenceKey),
          targetKeys: target.evidence.map(evidenceKey),
          reason: d.reason,
          evidence: d.evidence,
          confirmedAt: run.completedAt ?? project.updatedAt,
        })
      }
    }
  }
  return commits
}

export function commitCompletedRun(project: Project, assets: Asset[], run: EntityResolutionRun) {
  if (!project.identityResolution || run.status !== 'completed') throw new Error('消歧尚未完成')
  const commits = retainedCommits(project, assets)
  project.identityResolution.commits = commits
}

export function applyCommittedIdentities(project: Project) {
  const base = scopedEntityBase(project)
  const original = project.identityResolution
  const commits = retainedCommits(project, base.assets)
  const revoked = retractedCommitIds(project)
  for (const id of revoked)
    if (!commits.some((c) => c.id === id)) throw new Error('撤回commit不存在')
  const active = commits.filter((c) => !revoked.has(c.id))
  for (const correction of project.qualityCorrections ?? []) {
    const op = correction.operation
    if (op.type !== 'assign') continue
    const target = base.assets.find((a) => a.id === op.canonicalId)
    const from = base.assets.find((a) => a.id === op.fromId)
    if (
      !target ||
      !from ||
      new Set(op.evidenceKeys).size !== op.evidenceKeys.length ||
      !op.evidenceKeys.length ||
      op.evidenceKeys.some(
        (k) =>
          !from.evidence.some(
            (e) =>
              evidenceKey(e) === k &&
              correction.evidence.some(
                (proof) =>
                  proof.chapterId === e.chapterId &&
                  proof.start <= e.start &&
                  proof.end >= e.end &&
                  proof.quote.includes(e.quote),
              ),
          ),
      ) ||
      !correction.evidence.some((e) => e.quote.includes(target.name))
    )
      throw new Error('更正目标或逐条身份链证据不完整')
    active.push({
      id: correction.id,
      fromId: op.fromId,
      canonicalId: op.canonicalId,
      sourceSha256: correction.sourceSha256,
      subjectKeys: op.evidenceKeys,
      targetKeys: target.evidence.map(evidenceKey),
      evidence: correction.evidence,
      reason: `来源审查更正（${correction.reviewer}）：${correction.reason}`,
      confirmedAt: correction.at,
    })
  }
  const conflicts: NonNullable<typeof original>['conflicts'] = []
  const assignments = new Map<string, string>()
  const redirects = base.identityResolution.redirects
  const mentions: Record<string, string> = {}
  const acceptedSources = new Set<string>()
  const acceptedTargets = new Set<string>()
  const human = new Set(
    base.identityResolution.confirmations.flatMap((c) => [c.fromId, c.canonicalId]),
  )
  for (const c of active) {
    const from = base.assets.find((a) => a.id === c.fromId)
    const target = base.assets.find((a) => a.id === c.canonicalId)
    let reason: string | undefined
    if (prohibitedMatch(project, c.fromId, c.canonicalId)) reason = 'reviewed-distinct-entities'
    else if (c.sourceSha256 !== project.sourceSha256) reason = 'source-changed'
    else if (!from || !target || from.kind !== target.kind || from.id === target.id)
      reason = 'missing-or-invalid-identity'
    else if (acceptedSources.has(target.id) || acceptedTargets.has(from.id))
      reason = 'chain-or-cycle'
    else if (human.has(from.id) || human.has(target.id)) reason = 'human-confirmation-boundary'
    else if (!c.subjectKeys.length || !c.targetKeys.length || !c.evidence.length)
      reason = 'missing-confirmation-evidence'
    else if (
      c.subjectKeys.some((k) => !from.evidence.some((e) => evidenceKey(e) === k)) ||
      c.targetKeys.some((k) => !target.evidence.some((e) => evidenceKey(e) === k))
    )
      reason = 'confirmed-evidence-removed'
    else if (
      c.subjectKeys.some((k) => {
        const prior = assignments.get(mentionAddress(c.fromId, k))
        return prior && prior !== c.canonicalId
      })
    )
      reason = 'conflicting-confirmed-target'
    if (!reason) {
      const destinations = (id: string) =>
        new Set(
          base.assets
            .find((a) => a.id === id)
            ?.evidence.map((e) => {
              const key = evidenceKey(e)
              return id === c.fromId && c.subjectKeys.includes(key)
                ? c.canonicalId
                : (assignments.get(mentionAddress(id, key)) ?? id)
            }) ?? [id],
        )
      for (const { operation: op } of project.qualityCorrections ?? []) {
        if (
          op.type === 'distinct' &&
          [...destinations(op.leftId)].some((id) => destinations(op.rightId).has(id))
        )
          reason = 'reviewed-distinct-entities'
      }
    }
    if (reason) {
      conflicts.push({ commitId: c.id, reason })
      continue
    }
    acceptedSources.add(c.fromId)
    acceptedTargets.add(c.canonicalId)
    for (const k of c.subjectKeys) assignments.set(mentionAddress(c.fromId, k), c.canonicalId)
    base.identityResolution.decisions.push({
      fromId: c.fromId,
      canonicalId: c.canonicalId,
      candidateIds: [c.canonicalId],
      outcome: 'confirmed',
      reason: c.reason,
      evidence: c.evidence,
    })
  }
  const merged = new Map<string, Asset>()
  for (const a of base.assets) {
    const destinations = new Set<string>()
    for (const e of a.evidence) {
      const key = evidenceKey(e)
      const id = assignments.get(mentionAddress(a.id, key)) ?? a.id
      destinations.add(id)
      mentions[mentionAddress(a.id, key)] = id
      if (a.localIdentity) mentions[mentionAddress(a.localIdentity.legacyId, key)] = id
      const canonical = base.assets.find((b) => b.id === id)
      if (!canonical) throw new Error('消歧canonical丢失')
      const target = merged.get(id) ?? { ...canonical, aliases: [], descriptions: [], evidence: [] }
      target.aliases.push(...a.aliases, ...(a.id !== id && !a.localIdentity ? [a.name] : []))
      target.descriptions.push(...a.descriptions)
      target.evidence.push(e)
      merged.set(id, target)
    }
    if (destinations.size === 1 && !destinations.has(a.id)) redirects[a.id] = [...destinations][0]
  }
  // An old name bucket is compatible only while all its mentions resolve to one
  // identity. Never redirect an ambiguous book-wide 'woman' ID to an arbitrary one.
  for (const legacy of new Set(
    base.assets.flatMap((a) => (a.localIdentity ? [a.localIdentity.legacyId] : [])),
  )) {
    const destinations = new Set(
      base.assets
        .filter((a) => a.localIdentity?.legacyId === legacy)
        .flatMap((a) => a.evidence.map((e) => mentions[mentionAddress(a.id, evidenceKey(e))])),
    )
    if (destinations.size === 1) redirects[legacy] = [...destinations][0]
  }
  for (const correction of project.qualityCorrections ?? []) {
    const op = correction.operation
    if (op.type !== 'retype') continue
    const raw = project.chunks
      .flatMap((c) => c.mentions)
      .find(
        (m) => assetId(m.kind, m.name) === op.fromId && evidenceKey(m.evidence) === op.evidenceKey,
      )
    if (!raw) throw new Error('旧类型引用丢失')
    const destination = mentions[mentionAddress(assetId(op.kind, raw.name), op.evidenceKey)]
    if (!destination) throw new Error('更正类型引用丢失')
    mentions[mentionAddress(op.fromId, op.evidenceKey)] = destination
    const rawKeys = project.chunks
      .flatMap((c) => c.mentions)
      .filter((m) => assetId(m.kind, m.name) === op.fromId)
      .map((m) => evidenceKey(m.evidence))
    const targets = new Set(rawKeys.map((k) => mentions[mentionAddress(op.fromId, k)]))
    if (targets.size === 1 && rawKeys.every((k) => !!mentions[mentionAddress(op.fromId, k)]))
      redirects[op.fromId] = destination
  }
  for (const [from, target] of Object.entries(redirects))
    redirects[from] = redirects[target] ?? target
  base.assets = [...merged.values()].map((a) => ({
    ...a,
    aliases: [...new Set(a.aliases)]
      .filter((s) => s !== a.name && !(a.kind === 'character' && isGenericCharacterName(s)))
      .sort(),
    descriptions: [...new Set(a.descriptions)],
    evidence: [...new Map(a.evidence.map((e) => [evidenceKey(e), e])).values()],
  }))
  base.identityResolution = {
    ...base.identityResolution,
    ai: original?.ai,
    aiHistory: original?.aiHistory,
    commits,
    conflicts,
    mentionRedirects: mentions,
  }
  return base
}
