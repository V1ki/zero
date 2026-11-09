import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ENTITY_VERSION,
  entityBase,
  entitySnapshot,
  rebuildEntityAssets,
  runEntityResolution,
  verifyEntitySource,
} from './entity-resolution'
import { hash } from './extraction'
import { expandSubjectIds } from './identity-ledger'
import { fileManifest, verifyAliasMigration } from './migrate-aliases'
import { ProjectStore, atomicJson } from './store'
import type { Project } from './types'

export const ENTITY_WORK_ROOT = resolve(
  import.meta.dir,
  '../../../../workspace/zero-feishu/ip-video-entity-resolution',
)

// Explicit, bounded migration: never re-extract chapters. Preview also journals AI
// requests, but only --apply creates a full backup and atomically replaces the DB.
export async function resolveExistingEntities(
  store: ProjectStore,
  id: string,
  subjectIds: string[],
  options: {
    apply?: boolean
    workRoot?: string
    transport?: (url: string, init?: RequestInit) => Promise<Response>
    timeoutMs?: number
  } = {},
) {
  const directory = store.directory(id)
  const lock = join(directory, 'run.lock')
  writeFileSync(lock, JSON.stringify({ pid: process.pid, operation: 'entity-resolution' }), {
    flag: 'wx',
  })
  try {
    const before = store.read(id)
    if (before.status === 'running' || before.chunks.some((c) => c.status === 'running'))
      throw new Error('项目运行中，拒绝消歧迁移')
    const source = store.source(id)
    verifyEntitySource(before, source)
    const ids = expandSubjectIds(entityBase(before).assets, subjectIds)
    const snapshot = entitySnapshot(before)
    const job = join(
      options.workRoot ?? ENTITY_WORK_ROOT,
      id,
      snapshot,
      hash(JSON.stringify(ids)).slice(0, 16),
    )
    mkdirSync(join(job, 'entity-attempts'), { recursive: true })
    const manifest = fileManifest(directory)
    let backup: string | undefined
    const existing = before.identityResolution?.ai
    const alreadyDone =
      existing?.version === ENTITY_VERSION &&
      existing.snapshot === snapshot &&
      existing.status === 'completed' &&
      ids.every((subjectId) => existing.subjectIds.includes(subjectId))
    if (alreadyDone)
      return { applied: false, changed: false, job, counts: verifyAliasMigration(before, before) }
    if (options.apply) {
      const receipt = join(job, 'backup.json')
      if (existsSync(receipt)) {
        const saved = JSON.parse(readFileSync(receipt, 'utf8')) as {
          backup: string
          manifest: Record<string, string>
        }
        if (
          JSON.stringify(saved.manifest) === JSON.stringify(manifest) &&
          JSON.stringify(fileManifest(saved.backup)) === JSON.stringify(manifest)
        )
          backup = saved.backup
      }
      if (!backup) {
        backup = join(store.root, '..', 'ip-video-entity-backups', `${id}-${crypto.randomUUID()}`)
        mkdirSync(resolve(backup, '..'), { recursive: true })
        cpSync(directory, backup, {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter: (p) => p !== lock,
        })
        if (JSON.stringify(fileManifest(backup)) !== JSON.stringify(manifest))
          throw new Error('消歧备份校验失败')
        atomicJson(`${backup}.manifest.json`, manifest)
        atomicJson(receipt, { backup, manifest })
      }
    }
    const after = structuredClone(before)
    const journal = join(job, 'journal.json')
    if (existsSync(journal)) {
      const staged = JSON.parse(readFileSync(journal, 'utf8')) as Project
      if (staged.id !== id || entitySnapshot(staged) !== snapshot)
        throw new Error('消歧journal不匹配')
      if (!staged.identityResolution) throw new Error('消歧journal缺少身份审计')
      const durable = before.identityResolution?.commits ?? []
      const stagedCommits = staged.identityResolution.commits ?? []
      for (const commit of durable) {
        const duplicate = stagedCommits.find((c) => c.id === commit.id)
        if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(commit))
          throw new Error('消歧journal确认记录冲突')
      }
      after.identityResolution = {
        ...staged.identityResolution,
        commits: [...durable, ...stagedCommits.filter((c) => !durable.some((d) => d.id === c.id))],
        aiHistory: [
          ...new Map(
            [
              ...(before.identityResolution?.aiHistory ?? []),
              ...(staged.identityResolution.aiHistory ?? []),
            ].map((run) => [hash(JSON.stringify(run)), run]),
          ).values(),
        ],
      }
    }
    await runEntityResolution(after, source, ids, {
      transport: options.transport ?? fetch,
      timeoutMs: options.timeoutMs,
      save: () => atomicJson(journal, after),
      artifact: (relative, value) => atomicJson(join(job, relative), value),
    })
    Object.assign(after, rebuildEntityAssets(after))
    atomicJson(journal, after)
    if (after.identityResolution?.conflicts?.length)
      throw new Error(
        `消歧确认冲突，拒绝迁移：${JSON.stringify(after.identityResolution.conflicts)}`,
      )
    const counts = verifyAliasMigration(before, after)
    const changed =
      JSON.stringify(before.identityResolution) !== JSON.stringify(after.identityResolution) ||
      JSON.stringify(before.assets) !== JSON.stringify(after.assets)
    const result = {
      applied: !!options.apply && changed,
      changed,
      backup,
      job,
      counts,
      decisions: after.identityResolution?.ai?.decisions,
      redirects: after.identityResolution?.redirects,
    }
    if (!options.apply || !changed) {
      atomicJson(join(job, 'result.json'), result)
      return result
    }
    if (JSON.stringify(fileManifest(directory)) !== JSON.stringify(manifest))
      throw new Error('消歧期间原始库变化，拒绝覆盖')
    // Artifact copies may remain orphaned after a crash; project.json is the sole
    // commit point. Original extraction attempt bytes are never overwritten.
    cpSync(join(job, 'entity-attempts'), join(directory, 'entity-attempts'), { recursive: true })
    after.updatedAt = new Date().toISOString()
    atomicJson(join(directory, 'project.json'), after)
    verifyAliasMigration(before, store.read(id))
    const afterManifest = fileManifest(directory)
    for (const [path, digest] of Object.entries(manifest))
      if (path !== 'project.json' && afterManifest[path] !== digest)
        throw new Error(`原始文件变化：${path}`)
    atomicJson(join(job, 'result.json'), {
      ...result,
      beforeProjectSha256: manifest['project.json'],
      afterProjectSha256: afterManifest['project.json'],
      unchangedOriginalFiles: Object.keys(manifest).length - 1,
    })
    return result
  } finally {
    rmSync(lock)
  }
}

if (import.meta.main) {
  const [id, ids, flag] = process.argv.slice(2)
  if (!id || !ids || (flag && flag !== '--apply'))
    throw new Error(
      '用法：bun run resolve-entities.ts <projectId> <canonicalId,canonicalId> [--apply]；默认AI预览，不重跑原文',
    )
  console.log(
    JSON.stringify(
      await resolveExistingEntities(new ProjectStore(), id, ids.split(','), {
        apply: flag === '--apply',
      }),
      null,
      2,
    ),
  )
}
