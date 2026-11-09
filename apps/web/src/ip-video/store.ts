import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ENTITY_VERSION,
  candidateCatalog,
  checkpointVerifiedMatches,
  entityBase,
  entitySnapshot,
  isEntityRunComplete,
  rebuildEntityAssets,
  runEntityResolution,
} from './entity-resolution'
import {
  CHUNK_LIMIT,
  CORRECTION_PROMPT,
  CORRECTION_PROMPT_VERSION,
  ENDPOINT,
  EXTRACTION_EVIDENCE_PROMPT,
  MODEL,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  ValidationError,
  extractionQuoteOptions,
  hash,
  partitionSource,
  progress,
  validateExtraction,
} from './extraction'
import { verifyCorrectionSource } from './quality-corrections'
import type { Attempt, Chunk, Project, ProjectSummary, ProjectView } from './types'

export const DEFAULT_ROOT = resolve(
  import.meta.dir,
  '../../../../.zero/workspace/shared/ip-video-qwen8000',
)
type Transport = (url: string, init?: RequestInit) => Promise<Response>
export interface StartOptions {
  retryFailed?: boolean
  concurrency?: number
  /** Explicit operator scope. Never expands to all entities after extraction. */
  targeted?: { chunkIds: string[]; subjectIds: string[]; expectedProjectSha256?: string }
}
const now = () => new Date().toISOString()
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Raw HTTP responses can be non-JSON (or lack a textual assistant response).
function assistantContent(rawResponse: string | undefined): string | undefined {
  if (!rawResponse) return undefined
  let body: { choices?: { message?: { content?: unknown } }[] } | null
  try {
    body = JSON.parse(rawResponse)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  const content = body?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : undefined
}

async function withDeadline<T>(
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`请求超时（${milliseconds}ms）`)
      reject(error)
      controller.abort(error)
    }, milliseconds)
  })
  try {
    return await Promise.race([operation(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}

export function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2))
  renameSync(temporary, path)
}

export class ProjectStore {
  readonly events = new EventEmitter()
  private readonly active = new Map<string, Promise<void>>()
  constructor(
    readonly root = DEFAULT_ROOT,
    private readonly transport: Transport = fetch,
    private readonly requestTimeoutMs = 120_000,
    private readonly retryDelayMs = 1000,
  ) {
    mkdirSync(root, { recursive: true })
  }

  directory(id: string) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('无效项目ID')
    return join(this.root, id)
  }

  read(id: string): Project {
    return JSON.parse(readFileSync(join(this.directory(id), 'project.json'), 'utf8')) as Project
  }
  source(id: string) {
    return readFileSync(join(this.directory(id), 'source.txt'), 'utf8')
  }
  view(id: string): ProjectView {
    const project = this.read(id)
    return { ...project, progress: progress(project) }
  }
  list(): ProjectSummary[] {
    return readdirSync(this.root)
      .filter((id) => /^[a-f0-9]{24}$/.test(id) && existsSync(join(this.root, id, 'project.json')))
      .map((id) => {
        const p = this.read(id)
        return { id, title: p.title, status: p.status, updatedAt: p.updatedAt }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private save(project: Project) {
    project.updatedAt = now()
    if (project.qualityCorrections?.length) verifyCorrectionSource(project, this.source(project.id))
    Object.assign(project, rebuildEntityAssets(project))
    atomicJson(join(this.directory(project.id), 'project.json'), project)
    this.events.emit(project.id, { ...project, progress: progress(project) })
  }

  import(title: string, source: string): ProjectView {
    if (!title.trim() || title.length > 200) throw new Error('书名长度必须为1到200字符')
    if (Buffer.byteLength(source) > 20 * 1024 * 1024) throw new Error('原文超过20 MiB')
    const sourceSha256 = hash(source)
    const id = hash(
      `${sourceSha256}:${PROMPT_VERSION}:${hash(SYSTEM_PROMPT)}:${CHUNK_LIMIT}:${MODEL}`,
    ).slice(0, 24)
    const dir = this.directory(id)
    if (existsSync(join(dir, 'project.json'))) return this.view(id)
    const sections = partitionSource(source)
    mkdirSync(join(dir, 'attempts'), { recursive: true })
    writeFileSync(join(dir, 'source.txt'), source)
    writeFileSync(join(dir, 'prompt.txt'), SYSTEM_PROMPT)
    const project: Project = {
      schemaVersion: 1,
      id,
      title: title.trim(),
      createdAt: now(),
      updatedAt: now(),
      sourceSha256,
      sourceUtf16Length: source.length,
      sourceCodePoints: [...source].length,
      sourceBytes: Buffer.byteLength(source),
      model: MODEL,
      endpoint: ENDPOINT,
      promptVersion: PROMPT_VERSION,
      promptSha256: hash(SYSTEM_PROMPT),
      chunkLimit: CHUNK_LIMIT,
      status: 'ready',
      ...sections,
      assets: [],
      probes: [],
    }
    this.save(project)
    return this.view(id)
  }

  private lockIsLive(id: string): boolean {
    const path = join(this.directory(id), 'run.lock')
    if (!existsSync(path)) return false
    const owner = JSON.parse(readFileSync(path, 'utf8')) as { pid: number }
    if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('任务锁损坏，需要人工核对')
    try {
      process.kill(owner.pid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw error
    }
  }

  // No automatic model calls during startup. Interrupted jobs remain visible and
  // can explicitly resume from durable successful chunks without re-extracting them.
  recover() {
    for (const { id } of this.list()) {
      if (this.lockIsLive(id)) continue
      const lock = join(this.directory(id), 'run.lock')
      // A stale lock is an explicit operator-visible condition. Do not unlink a
      // lock after checking its PID: another process may have acquired it meanwhile.
      if (existsSync(lock)) continue
      try {
        writeFileSync(lock, JSON.stringify({ pid: process.pid, operation: 'recovery' }), {
          flag: 'wx',
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      try {
        const project = this.read(id)
        if (project.status !== 'running') continue
        this.recoverChunks(project)
        if (project.identityResolution?.ai?.status === 'running') {
          project.identityResolution.ai.status = 'interrupted'
          for (const attempt of project.identityResolution.ai.attempts)
            if (attempt.status === 'running') attempt.status = 'interrupted'
        }
        project.status = 'interrupted'
        project.error = '进程中断；已保存成功分块，可继续分析'
        this.save(project)
      } finally {
        rmSync(lock)
      }
    }
  }

  private recoverChunks(project: Project) {
    for (const chunk of project.chunks) {
      if (chunk.status !== 'running') continue
      chunk.status = 'pending'
      chunk.error = '上次请求被进程中断，是否已在模型侧计费未知'
      for (const attempt of chunk.attempts)
        if (attempt.status === 'running') {
          attempt.status = 'interrupted'
          attempt.endedAt = now()
          attempt.error = chunk.error
        }
    }
  }

  start(id: string, options: StartOptions = {}): Promise<void> {
    const existing = this.active.get(id)
    if (existing) return existing
    if (this.lockIsLive(id)) throw new Error('该项目由另一个进程分析中')
    const lockPath = join(this.directory(id), 'run.lock')
    if (existsSync(lockPath)) throw new Error('遗留任务锁需要先核对所有者，拒绝自动删除')
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: now() }), { flag: 'wx' })
    const task = this.run(id, options).finally(() => {
      rmSync(lockPath, { force: true })
      this.active.delete(id)
    })
    this.active.set(id, task)
    return task
  }

  async wait(id: string) {
    await this.active.get(id)
  }

  private async run(id: string, options: StartOptions) {
    const project = this.read(id)
    // Validate before the mutation/error-persistence path. A malformed scope must
    // not rewrite project.json or start recovery of unrelated work.
    if (options.targeted) {
      const { chunkIds, subjectIds } = options.targeted
      if (
        options.targeted.expectedProjectSha256 &&
        hash(readFileSync(join(this.directory(id), 'project.json'), 'utf8')) !==
          options.targeted.expectedProjectSha256
      )
        throw new Error('局部执行取得锁后项目与备份快照不一致')
      const base = entityBase(project)
      if (
        new Set(chunkIds).size !== chunkIds.length ||
        new Set(subjectIds).size !== subjectIds.length ||
        chunkIds.some((id) => !project.chunks.some((c) => c.id === id)) ||
        subjectIds.some((id) => !base.assets.some((a) => a.id === id)) ||
        project.status === 'running' ||
        project.chunks.some((c) => c.status === 'running')
      )
        throw new Error('局部执行范围无效或项目仍在运行')
    }
    try {
      const source = this.source(id)
      const originalPrompt = readFileSync(join(this.directory(id), 'prompt.txt'), 'utf8')
      if (
        hash(source) !== project.sourceSha256 ||
        project.model !== MODEL ||
        project.endpoint !== ENDPOINT ||
        project.promptVersion !== PROMPT_VERSION ||
        project.promptSha256 !== hash(SYSTEM_PROMPT) ||
        hash(originalPrompt) !== project.promptSha256
      )
        throw new Error('原文或提取配置完整性校验失败')
      if (options.targeted && project.identityResolution?.ai) {
        const identity = project.identityResolution
        const originalRun = project.identityResolution.ai
        identity.aiHistory ??= []
        const original = JSON.stringify(identity.ai)
        if (!identity.aiHistory.some((run) => JSON.stringify(run) === original))
          identity.aiHistory.push(structuredClone(originalRun))
      }
      checkpointVerifiedMatches(project, source)
      this.recoverChunks(project)
      if (options.retryFailed)
        for (const chunk of project.chunks)
          if (
            chunk.status === 'failed' &&
            (!options.targeted || options.targeted.chunkIds.includes(chunk.id))
          ) {
            chunk.status = 'pending'
          }
      const queue = project.chunks.filter(
        (chunk) =>
          chunk.status === 'pending' &&
          (!options.targeted || options.targeted.chunkIds.includes(chunk.id)),
      )
      if (!queue.length) {
        // Keep completed explicit scopes intact, but do not trust status alone
        // when its snapshot, coverage or recorded failures disagree.
        if (
          (options.targeted ||
            !isEntityRunComplete(project.identityResolution?.ai, entitySnapshot(project))) &&
          entityBase(project).assets.length > 1
        ) {
          project.status = 'running'
          this.save(project)
          await this.resolveIdentities(project, source, options.targeted?.subjectIds)
        }
        this.finish(project, !!options.targeted)
        this.save(project)
        return
      }
      project.status = 'running'
      project.error = undefined
      this.save(project)
      // Fail the job visibly before sending hundreds of requests to an unreachable
      // or misconfigured endpoint. Pending coverage must never be reported as AI success.
      const probe: Project['probes'][number] = { at: now() }
      project.probes.push(probe)
      try {
        const models = await withDeadline(
          Math.min(this.requestTimeoutMs, 15000),
          async (signal) => {
            const response = await this.transport(`${ENDPOINT}/models`, { signal })
            if (!response.ok) throw new Error(`模型探测HTTP ${response.status}`)
            return (await response.json()) as { data?: { id?: string }[] }
          },
        )
        probe.models = models
        if (!models.data?.some((model) => model.id === MODEL))
          throw new Error(`接口未公布唯一指定模型 ${MODEL}`)
      } catch (error) {
        probe.error = errorText(error)
        project.status = 'blocked'
        project.error = `模型预检失败：${probe.error}`
        this.save(project)
        return
      }
      this.save(project)
      let cursor = 0
      const concurrency = Math.max(4, Math.min(8, Math.floor(options.concurrency ?? 6)))
      const workers = await Promise.allSettled(
        Array.from({ length: concurrency }, async () => {
          while (cursor < queue.length) {
            const chunk = queue[cursor++]
            await this.extract(project, source, chunk)
          }
        }),
      )
      const failure = workers.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      // All successful chunks are now visible, including later real names. This
      // second AI phase also repairs concurrency/order gaps in extraction context.
      await this.resolveIdentities(project, source, options.targeted?.subjectIds)
      this.finish(project, !!options.targeted)
      this.save(project)
    } catch (error) {
      this.recoverChunks(project)
      project.status = 'failed'
      project.error = errorText(error)
      this.save(project)
      throw error
    }
  }

  private finish(project: Project, targeted = false) {
    if (targeted) {
      project.status = 'interrupted'
      project.error =
        '局部执行已结束；历史全库结果保留，未执行全库重新审查，不能标记全书质量验收完成'
      return
    }
    const ai = project.identityResolution?.ai
    const identityComplete = !ai || isEntityRunComplete(ai, entitySnapshot(project))
    const chunksComplete = project.chunks.every((c) => c.status === 'succeeded')
    project.status = chunksComplete && identityComplete ? 'completed' : 'failed'
    project.error = !identityComplete
      ? '身份审查未完整完成；请查看身份失败审计并续跑'
      : !chunksComplete
        ? '部分分块失败；可重试失败分块，成功分块不会重复请求'
        : undefined
  }

  private async resolveIdentities(project: Project, source: string, explicitIds?: string[]) {
    const assets = entityBase(project).assets
    const subjectIds =
      explicitIds ??
      assets.filter((a) => assets.some((b) => b.id !== a.id && b.kind === a.kind)).map((a) => a.id)
    if (subjectIds.length)
      await runEntityResolution(project, source, subjectIds, {
        transport: this.transport,
        timeoutMs: this.requestTimeoutMs,
        save: () => this.save(project),
        artifact: (relative, value) => {
          mkdirSync(join(this.directory(project.id), 'entity-attempts'), { recursive: true })
          atomicJson(join(this.directory(project.id), relative), value)
        },
      })
  }

  private async extract(project: Project, source: string, chunk: Chunk) {
    const chapter = project.chapters.find((c) => c.id === chunk.chapterId)
    if (!chapter) throw new Error('分块缺少章节')
    const baseRequest = {
      model: MODEL,
      messages: [
        { role: 'system', content: `${SYSTEM_PROMPT}\n${EXTRACTION_EVIDENCE_PROMPT}` },
        {
          role: 'user',
          content: JSON.stringify({
            chapter: chapter.title,
            start: chunk.start,
            end: chunk.end,
            text: source.slice(chunk.start, chunk.end),
            quoteOptions: extractionQuoteOptions(source.slice(chunk.start, chunk.end)),
            instructions: CORRECTION_PROMPT,
            identityContext: {
              version: ENTITY_VERSION,
              projectId: project.id,
              candidates: candidateCatalog(project.assets).slice(0, 400),
              complete: project.assets.length <= 400,
              instructions:
                '已有资产仅为同项目身份线索，不是原文事实。当前抽取仍使用当前原文名称和逐字引用，不写候选ID；抽取完成后另行执行带结构化决策的AI身份消歧。',
            },
          }),
        },
      ],
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false },
      stream: false,
    }
    // Load only the latest failed/interrupted attempt, including across restarts.
    // Never replay its request: that would recursively embed older responses.
    const previous = chunk.attempts.findLast((attempt) => attempt.error)
    let feedback = previous?.error ?? chunk.error
    let previousContent: string | undefined
    if (previous?.responseFile) {
      const path = join(this.directory(project.id), previous.responseFile)
      if (existsSync(path)) {
        const artifact = JSON.parse(readFileSync(path, 'utf8')) as { rawResponse?: string }
        previousContent = assistantContent(artifact.rawResponse)
      }
    }
    for (let retry = 0; retry < 3; retry++) {
      const messages = [...baseRequest.messages]
      if (feedback) {
        if (previousContent !== undefined)
          messages.push({ role: 'assistant', content: previousContent })
        messages.push({
          role: 'user',
          content: JSON.stringify({ instructions: CORRECTION_PROMPT, previousError: feedback }),
        })
      }
      const request = { ...baseRequest, messages }
      const trace = {
        chunkId: chunk.id,
        endpoint: ENDPOINT,
        promptVersion: project.promptVersion,
        promptSha256: project.promptSha256,
        effectiveSystemPromptSha256: hash(baseRequest.messages[0].content),
        evidenceProtocolVersion: 'quote-id-v1',
        evidenceProtocolSha256: hash(EXTRACTION_EVIDENCE_PROMPT),
        correctionPromptVersion: CORRECTION_PROMPT_VERSION,
        correctionPromptSha256: hash(CORRECTION_PROMPT),
        entityContextVersion: ENTITY_VERSION,
        requestSha256: hash(JSON.stringify(request)),
        request,
      }
      const attempt: Attempt = { id: crypto.randomUUID(), startedAt: now(), status: 'running' }
      chunk.status = 'running'
      chunk.attempts.push(attempt)
      attempt.responseFile = `attempts/${attempt.id}.json`
      const attemptPath = join(this.directory(project.id), attempt.responseFile)
      atomicJson(attemptPath, {
        ...trace,
        attempt,
      })
      this.save(project)
      let rawResponse: string | undefined
      try {
        const received = await withDeadline(this.requestTimeoutMs, async (signal) => {
          const response = await this.transport(`${ENDPOINT}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            signal,
          })
          return { status: response.status, ok: response.ok, text: await response.text() }
        })
        attempt.httpStatus = received.status
        rawResponse = received.text
        if (!received.ok)
          throw new Error(`模型HTTP ${received.status}: ${rawResponse.slice(0, 500)}`)
        const body = JSON.parse(rawResponse) as {
          model?: string
          usage?: Record<string, unknown>
          choices?: { finish_reason?: string; message?: { content?: string } }[]
        }
        attempt.responseModel = body.model
        attempt.usage = body.usage
        if (body.model !== MODEL) throw new Error(`模型标识不匹配：${body.model ?? '缺失'}`)
        const choice = body.choices?.[0]
        if (choice?.finish_reason !== 'stop')
          throw new Error(`响应未完整结束：${choice?.finish_reason ?? '缺失'}`)
        if (typeof choice.message?.content !== 'string') throw new Error('模型未返回文本')
        chunk.mentions = validateExtraction(choice.message.content, source, chunk, chapter)
        chunk.status = 'succeeded'
        chunk.error = undefined
        attempt.status = 'succeeded'
      } catch (error) {
        attempt.status = 'failed'
        attempt.error = errorText(error)
        if (error instanceof ValidationError) attempt.rejectedQuotes = error.rejectedQuotes
        feedback = attempt.error
        previousContent = assistantContent(rawResponse)
        chunk.error = attempt.error
        chunk.status = retry === 2 ? 'failed' : 'running'
      }
      attempt.endedAt = now()
      atomicJson(attemptPath, {
        ...trace,
        rawResponse,
        attempt,
      })
      this.save(project)
      if (chunk.status === 'succeeded') return
      if (retry < 2)
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * 2 ** retry))
    }
  }
}
