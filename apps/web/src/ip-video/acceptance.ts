import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hash, progress } from './extraction'
import { DEFAULT_ROOT, ProjectStore, atomicJson } from './store'
import type { Project } from './types'

export const DEFAULT_SOURCE = resolve(
  import.meta.dir,
  '../../../../.zero/workspace/shared/从骑奴到大乾武圣_第1-244章_去重版.txt',
)

export function auditProject(project: Project, source: string) {
  const issues: string[] = []
  if (hash(source) !== project.sourceSha256) issues.push('原文SHA256不匹配')
  let cursor = 0
  for (const chapter of project.chapters) {
    if (chapter.start !== cursor || chapter.end <= chapter.start)
      issues.push(`章节范围不连续: ${chapter.id}`)
    cursor = chapter.end
    const chunks = project.chunks.filter((c) => c.chapterId === chapter.id)
    if (chunks.map((c) => c.id).join(',') !== chapter.chunkIds.join(','))
      issues.push(`章节分块索引不匹配: ${chapter.id}`)
    if (chunks[0]?.start !== chapter.start || chunks.at(-1)?.end !== chapter.end)
      issues.push(`章节未完整覆盖: ${chapter.id}`)
  }
  if (cursor !== source.length) issues.push('章节未覆盖全文')
  cursor = 0
  for (const chunk of project.chunks) {
    if (
      chunk.start !== cursor ||
      chunk.end <= chunk.start ||
      chunk.end - chunk.start > project.chunkLimit
    )
      issues.push(`分块范围错误: ${chunk.id}`)
    cursor = chunk.end
  }
  if (cursor !== source.length) issues.push('分块未覆盖全文')
  if (project.chunks.map((c) => source.slice(c.start, c.end)).join('') !== source)
    issues.push('分块重组与原文不同')
  let quotes = 0
  for (const asset of project.assets)
    for (const evidence of asset.evidence) {
      quotes++
      const chunk = project.chunks.find((c) => c.id === evidence.chunkId)
      const chapter = project.chapters.find((c) => c.id === evidence.chapterId)
      if (
        !chunk ||
        chunk.status !== 'succeeded' ||
        !chapter ||
        chunk.chapterId !== chapter.id ||
        evidence.start < chunk.start ||
        evidence.end > chunk.end ||
        evidence.chapterOffset !== evidence.start - chapter.start ||
        source.slice(evidence.start, evidence.end) !== evidence.quote
      )
        issues.push(`引用校验失败: ${asset.id}/${evidence.chunkId}`)
    }
  const attempts = project.chunks.flatMap((c) => c.attempts)
  const usage: Record<string, number> = {}
  for (const attempt of attempts)
    for (const [key, value] of Object.entries(attempt.usage ?? {}))
      if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value
  const chapterNumbers = project.chapters.flatMap((c) => (c.number === null ? [] : [c.number]))
  const stats = progress(project)
  return {
    auditedAt: new Date().toISOString(),
    projectId: project.id,
    status: project.status,
    error: project.error ?? null,
    source: {
      sha256: hash(source),
      bytes: Buffer.byteLength(source),
      utf16Units: source.length,
      unicodeCodePoints: [...source].length,
      nonWhitespaceCodePoints: [...source.replace(/\s/g, '')].length,
    },
    chapterNumbers,
    numberedChapters: chapterNumbers.length,
    sectionsIncludingPreface: project.chapters.length,
    partition: {
      issues,
      lossless: issues.length === 0,
      chunks: project.chunks.length,
      maxChunkUtf16: Math.max(...project.chunks.map((c) => c.end - c.start)),
      coveredUtf16: project.chunks.reduce((sum, c) => sum + c.end - c.start, 0),
    },
    extraction: {
      total: stats.total,
      succeeded: stats.succeeded,
      failed: stats.failed,
      pending: stats.pending,
      running: stats.running,
      successfulSourceUtf16: stats.coveredUtf16,
      successfulChapters: stats.chapters.filter(
        (c) => c.status === 'succeeded' && c.number !== null,
      ).length,
      allSucceeded:
        project.status === 'completed' && stats.succeeded === stats.total && issues.length === 0,
    },
    assets: {
      total: project.assets.length,
      character: project.assets.filter((a) => a.kind === 'character').length,
      location: project.assets.filter((a) => a.kind === 'location').length,
      prop: project.assets.filter((a) => a.kind === 'prop').length,
      quotes,
      rejectedQuoteAttempts: attempts.filter((a) => (a.rejectedQuotes ?? 0) > 0).length,
    },
    requests: {
      attempts: attempts.length,
      succeeded: attempts.filter((a) => a.status === 'succeeded').length,
      failed: attempts.filter((a) => a.status === 'failed').length,
      interrupted: attempts.filter((a) => a.status === 'interrupted').length,
      withUsage: attempts.filter((a) => a.usage).length,
      usage,
      observedModels: [
        ...new Set(attempts.flatMap((a) => (a.responseModel ? [a.responseModel] : []))),
      ],
    },
    configuration: {
      model: project.model,
      endpoint: project.endpoint,
      promptVersion: project.promptVersion,
      promptSha256: project.promptSha256,
      concurrency: 6,
      maxAttemptsPerRun: 3,
      requestTimeoutMs: 120000,
      thinking: false,
    },
    probes: project.probes,
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const offline = args.includes('--offline')
  const path = args.find((arg) => !arg.startsWith('--')) ?? DEFAULT_SOURCE
  const store = new ProjectStore(DEFAULT_ROOT)
  store.recover()
  const source = readFileSync(path, 'utf8')
  const project = store.import(
    path
      .split('/')
      .at(-1)
      ?.replace(/\.txt$/i, '') ?? '小说',
    source,
  )
  const numbers = project.chapters.flatMap((c) => (c.number === null ? [] : [c.number]))
  if (
    path === DEFAULT_SOURCE &&
    (numbers.length !== 244 || numbers.some((value, index) => value !== index + 1))
  )
    throw new Error('目标小说未解析出连续第1到244章')
  const before = auditProject(project, source)
  if (!before.partition.lossless) throw new Error(before.partition.issues.join('; '))
  console.log(
    JSON.stringify({
      event: 'partition_verified',
      projectId: project.id,
      numberedChapters: numbers.length,
      chunks: project.chunks.length,
      sourceUtf16: source.length,
      offline,
    }),
  )
  let last = ''
  store.events.on(project.id, (next: Project) => {
    const p = progress(next)
    const key = `${next.status}:${p.succeeded}:${p.failed}`
    if (key !== last) {
      console.log(
        JSON.stringify({
          event: 'progress',
          status: next.status,
          succeeded: p.succeeded,
          failed: p.failed,
          total: p.total,
          error: next.error,
        }),
      )
      last = key
    }
  })
  let executionError: string | undefined
  if (!offline) {
    try {
      await store.start(project.id, { retryFailed: true, concurrency: 6 })
    } catch (error) {
      executionError = error instanceof Error ? error.message : String(error)
    }
  }
  const final = store.read(project.id)
  const result = {
    ...auditProject(final, source),
    mode: offline ? 'offline-partition-only' : 'real-model-run',
    sourcePath: path,
    executionError,
  }
  const dir = store.directory(project.id)
  atomicJson(join(dir, offline ? 'acceptance-offline.json' : 'acceptance.json'), result)
  atomicJson(
    join(dir, 'coverage.json'),
    final.chunks.map((chunk) => ({
      id: chunk.id,
      chapterId: chunk.chapterId,
      start: chunk.start,
      end: chunk.end,
      sha256: hash(source.slice(chunk.start, chunk.end)),
      status: chunk.status,
    })),
  )
  writeFileSync(
    join(dir, 'run-summary.md'),
    `# 全书运行记录\n\n模式：${result.mode}\n\n状态：${final.status}\n\n${JSON.stringify(result, null, 2)}\n`,
  )
  console.log(
    JSON.stringify({
      event: 'finished',
      status: final.status,
      allSucceeded: result.extraction.allSucceeded,
      report: join(dir, 'acceptance.json'),
      executionError,
    }),
  )
  process.exitCode = offline
    ? result.partition.lossless
      ? 0
      : 1
    : result.extraction.allSucceeded
      ? 0
      : 2
}
