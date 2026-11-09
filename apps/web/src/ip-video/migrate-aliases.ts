import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { rebuildEntityAssets } from './entity-resolution'
import { evidenceKey, isGenericCharacterName, resolveAssets } from './extraction'
import { mentionAddress } from './identity-ledger'
import { ProjectStore, atomicJson } from './store'
import type { IdentityConfirmation, Project } from './types'

export function fileManifest(directory: string): Record<string, string> {
  const entries: [string, string][] = []
  function visit(relative: string) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name)
      if (path === 'run.lock') continue
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile())
        entries.push([
          path,
          createHash('sha256')
            .update(readFileSync(join(directory, path)))
            .digest('hex'),
        ])
      else throw new Error(`迁移目录包含非普通文件：${path}`)
    }
  }
  visit('')
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))
}

// Compare evidence per resulting identity, not just totals: a dropped reference
// cannot be compensated for by duplicating another character's reference.
export function verifyAliasMigration(before: Project, after: Project) {
  const redirects = after.identityResolution?.redirects ?? {}
  const destination = (id: string, key: string) =>
    after.identityResolution?.mentionRedirects?.[mentionAddress(id, key)] ?? redirects[id] ?? id
  const references = (project: Project) =>
    [
      ...new Set(
        project.assets.flatMap((asset) =>
          asset.evidence.map((e) => `${destination(asset.id, evidenceKey(e))}:${evidenceKey(e)}`),
        ),
      ),
    ].sort()
  if (JSON.stringify(references(before)) !== JSON.stringify(references(after)))
    throw new Error('迁移引用不守恒')
  for (const asset of before.assets) {
    const targets = asset.evidence.map((e) =>
      after.assets.find((a) => a.id === destination(asset.id, evidenceKey(e))),
    )
    const names = targets.flatMap((a) => (a ? [a.name, ...a.aliases] : []))
    const descriptions = targets.flatMap((a) => a?.descriptions ?? [])
    if (
      targets.some((a) => !a) ||
      asset.descriptions.some((d) => !descriptions.includes(d)) ||
      [...asset.aliases, asset.name].some(
        (name) =>
          !names.includes(name) && !(asset.kind === 'character' && isGenericCharacterName(name)),
      )
    )
      throw new Error(`迁移丢失名称或描述：${asset.id}`)
  }

  const immutable = (project: Project) => {
    const { assets: _assets, identityResolution: _identity, updatedAt: _updated, ...rest } = project
    return JSON.stringify(rest)
  }
  if (immutable(before) !== immutable(after)) throw new Error('迁移修改了原始提取记录')
  return {
    beforeAssets: before.assets.length,
    afterAssets: after.assets.length,
    beforeReferences: before.assets.reduce((sum, a) => sum + a.evidence.length, 0),
    afterReferences: after.assets.reduce((sum, a) => sum + a.evidence.length, 0),
    uniqueIdentityReferences: references(after).length,
    rawMentions: before.chunks.reduce((sum, c) => sum + c.mentions.length, 0),
  }
}

export function migrateAliases(
  store: ProjectStore,
  id: string,
  confirmations: IdentityConfirmation[],
  apply = false,
) {
  const directory = store.directory(id)
  const lock = join(directory, 'run.lock')
  // Shares the execution lock with both old and new services. Never removes a
  // pre-existing lock (including a stale one) or starts/resumes model execution.
  writeFileSync(
    lock,
    JSON.stringify({
      pid: process.pid,
      at: new Date().toISOString(),
      operation: 'alias-migration',
    }),
    { flag: 'wx' },
  )
  try {
    const before = store.read(id)
    if (before.status === 'running' || before.chunks.some((c) => c.status === 'running'))
      throw new Error('项目仍在运行，拒绝迁移')
    const source = store.source(id)
    for (const chunk of before.chunks) {
      for (const mention of chunk.mentions) {
        const e = mention.evidence
        const chapter = before.chapters.find((c) => c.id === e.chapterId)
        if (
          !chapter ||
          e.chunkId !== chunk.id ||
          chapter.id !== chunk.chapterId ||
          e.start < chunk.start ||
          e.end > chunk.end ||
          e.end <= e.start ||
          e.chapterOffset !== e.start - chapter.start ||
          source.slice(e.start, e.end) !== e.quote
        )
          throw new Error('原始引用/offset校验失败')
      }
    }
    const combined = [...(before.identityResolution?.confirmations ?? [])]
    for (const confirmation of confirmations) {
      const existing = combined.find((c) => c.fromId === confirmation.fromId)
      if (existing && JSON.stringify(existing) !== JSON.stringify(confirmation))
        throw new Error('已有确认不一致')
      if (!existing) combined.push(confirmation)
    }
    const after: Project = { ...before, ...resolveAssets(before.chunks, combined) }
    if (before.identityResolution?.ai || before.identityResolution?.commits) {
      if (!after.identityResolution) throw new Error('身份重建元数据缺失')
      after.identityResolution = {
        ...after.identityResolution,
        ai: before.identityResolution.ai,
        aiHistory: before.identityResolution.aiHistory,
        commits: before.identityResolution.commits,
      }
      Object.assign(after, rebuildEntityAssets(after))
    }
    const counts = verifyAliasMigration(before, after)
    const changed =
      JSON.stringify(before.assets) !== JSON.stringify(after.assets) ||
      JSON.stringify(before.identityResolution) !== JSON.stringify(after.identityResolution)
    if (!apply || !changed)
      return { applied: false, changed, counts, identityResolution: after.identityResolution }
    const manifest = fileManifest(directory)
    const backup = join(
      store.root,
      '..',
      'ip-video-alias-backups',
      `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`,
    )
    mkdirSync(resolve(backup, '..'), { recursive: true })
    cpSync(directory, backup, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (path) => path !== lock,
    })
    if (JSON.stringify(manifest) !== JSON.stringify(fileManifest(backup)))
      throw new Error('备份完整性校验失败')
    atomicJson(`${backup}.manifest.json`, manifest)
    if (JSON.stringify(manifest) !== JSON.stringify(fileManifest(directory)))
      throw new Error('迁移期间原始文件发生变化')
    after.updatedAt = new Date().toISOString()
    atomicJson(join(directory, 'project.json'), after)
    verifyAliasMigration(before, store.read(id))
    const afterManifest = fileManifest(directory)
    for (const [path, digest] of Object.entries(manifest)) {
      if (path !== 'project.json' && afterManifest[path] !== digest)
        throw new Error(`原始文件发生变化：${path}`)
    }
    return {
      applied: true,
      changed,
      backup,
      counts,
      identityResolution: after.identityResolution,
      unchangedFiles: Object.keys(manifest).length - 1,
      beforeProjectSha256: manifest['project.json'],
      afterProjectSha256: afterManifest['project.json'],
    }
  } finally {
    rmSync(lock)
  }
}

if (import.meta.main) {
  const [id, confirmationPath, flag] = process.argv.slice(2)
  if (!id || !confirmationPath || !existsSync(confirmationPath) || (flag && flag !== '--apply'))
    throw new Error(
      '用法：bun run migrate-aliases.ts <projectId> <confirmations.json> [--apply]；默认只预览',
    )
  const confirmations: unknown = JSON.parse(readFileSync(confirmationPath, 'utf8'))
  if (
    !Array.isArray(confirmations) ||
    confirmations.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        ['fromId', 'canonicalId', 'confirmedBy', 'confirmedAt', 'reason'].some(
          (key) => typeof item[key] !== 'string',
        ),
    )
  )
    throw new Error('确认文件必须为IdentityConfirmation数组')
  console.log(
    JSON.stringify(
      migrateAliases(
        new ProjectStore(),
        id,
        confirmations as IdentityConfirmation[],
        flag === '--apply',
      ),
      null,
      2,
    ),
  )
}
