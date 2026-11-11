import type { RouterJobReceipt, TriggerConversationTurn } from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'

const jobStates: Record<RouterJobReceipt['status'], string> = {
  queued: '已排队',
  running: '执行中',
  completed: '已完成',
  failed: '执行失败',
  unknown: '执行结果待核对',
}

/** What the owner sends to answer an open decision. Continuing a Codex job with it needs no further check. */
export function decisionAnswer(jobId: number, option: number) {
  return `继续派工 #${jobId}：选 ${option}`
}

/** How to see the full result once a report replaces it. Read through `get_task_status`. */
export function fullResultRequest(jobId: number) {
  return `查看派工 #${jobId} 的完整结果`
}

/**
 * Preset sentences of a GitHub task conversation's quick buttons. Each is sent as the owner's own
 * message, so it is the executor's authoritative instruction and what the write check reads.
 */
export function taskFixRequest(repository: string) {
  return `修复这项任务报告的问题：在 ${repository} 里查清原因，修改代码并运行相关测试，确认问题已经解决。`
}

export function taskAnalysisRequest(repository: string) {
  return `深入分析这项任务报告的问题：查清 ${repository} 里的原因和影响范围，给出修复建议，先不要修改代码。`
}

export function jobReply(job: RouterJobReceipt): string {
  const executor = job.executor === 'codex' ? 'Codex' : 'ZeRo'
  const target = job.repository ? ` · ${job.repository}` : ''
  const status = `派工 #${job.id}（${executor}${target}）${jobStates[job.status]}。`
  if (job.status === 'completed' && job.reportPending) return `${status}正在整理结果。`
  const report = job.status === 'completed' ? job.report : undefined
  if (!report) return `${status}${job.result ? `\n${job.result}` : ''}`
  const decision = !job.continued && report.decision
  return [
    status,
    report.verdict,
    ...(decision
      ? [
          `需要你决定：${decision.question}`,
          ...decision.options.map(
            (option, index) =>
              `${index + 1}. ${option}${index === decision.recommended ? '（推荐）' : ''}`,
          ),
          `回复「${decisionAnswer(job.id, decision.recommended + 1)}」即可按所选继续，换成其他选项的编号也可以。`,
        ]
      : []),
    `完整结果：发送「${fullResultRequest(job.id)}」。`,
  ].join('\n')
}

/** The option an owner picked by number in a sentence such as `decisionAnswer` prints. */
export function chosenOption(question: string, job: RouterJobReceipt) {
  const decision = job.status === 'completed' && !job.continued && job.report?.decision
  if (!decision) return undefined
  const picks = [...question.matchAll(/选(?:择)?\s*(?:第\s*)?([1-9])(?!\d)/gu)].map((m) =>
    Number(m[1]),
  )
  if (picks.length !== 1) return undefined
  const option = decision.options[picks[0] - 1]
  return option === undefined
    ? undefined
    : { question: decision.question, option, number: picks[0] }
}

/** Whether the sentence is the reply `jobReply` printed for this option, up to spacing and a colon. */
export function isPrintedDecisionAnswer(question: string, jobId: number, option: number) {
  const plain = (text: string) =>
    text
      .replace(/\s+/gu, '')
      .replaceAll(':', '：')
      .replace(/[。.!！]+$/u, '')
  return plain(question) === plain(decisionAnswer(jobId, option))
}

const fullName = /^[a-z0-9-]+\/[a-z0-9._-]+$/iu

/** The repository argument of read-only work. The GitHub grant for it is checked separately. */
export function readJobRepository(supplied: unknown): string | undefined {
  if (supplied === undefined) return undefined
  if (typeof supplied !== 'string' || !fullName.test(supplied))
    throw new TriggerAgentError('请提供仓库全名，例如 owner/repository。')
  return supplied
}

const nameRepository =
  '没有启动 Codex：请在消息里写明要修改的仓库，例如「修复 owner/repository 里失败的测试」。'

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** Whether the owner's sentence writes this repository, by full name or by its bare name. */
export function sentenceNamesRepository(question: string, repository: string): boolean {
  const name = repository.split('/')[1]
  if (!name) return false
  const sentence = question.replace(/https?:\/\/github\.com\//giu, ' ')
  return [repository, name].some((text) =>
    new RegExp(`(?<![a-z0-9._/-])${escapeRegExp(text)}(?![a-z0-9_/-]|\\.[a-z0-9])`, 'iu').test(
      sentence,
    ),
  )
}

/** Full repository names written in the owner's sentence, including github.com links. */
function writtenRepositories(question: string) {
  return [
    ...question.matchAll(
      /(?<![a-z0-9./_-])(?:https?:\/\/github\.com\/)?([a-z0-9-]+\/[a-z0-9._-]*[a-z0-9_-])/giu,
    ),
  ].map((match) => match[1].replace(/\.git$/iu, ''))
}

/** Whether the sentence writes the bare name of this registered repository. */
function namesBare(question: string, repository: string) {
  const name = repository.split('/')[1]
  return new RegExp(`(?<![a-z0-9._/-])${escapeRegExp(name)}(?![a-z0-9_/-]|\\.[a-z0-9])`, 'iu').test(
    question,
  )
}

/**
 * The repository of work delegated from a task conversation: always the task's own repository,
 * which comes from the owner's mandate. Another repository named by the model's argument or written
 * in the owner's sentence (in full, or for Codex by the bare name of another registered checkout)
 * is refused rather than redirected, because the task conversation is about this repository only.
 */
export function taskJobRepository(
  question: string,
  supplied: unknown,
  repository: string,
  registered: readonly string[] = [],
): string {
  const same = (candidate: string) => candidate.toLowerCase() === repository.toLowerCase()
  const name = repository.split('/')[1]?.toLowerCase()
  const elsewhere = (target: string) =>
    new TriggerAgentError(
      `这项任务的派工只能在 ${repository} 里进行${target ? `，不能改到 ${target}` : ''}。要处理其他仓库，请到 Router 主对话里提出。`,
    )
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || !supplied.trim()) throw elsewhere('')
    const wanted = supplied.trim()
    if (!same(wanted) && wanted.toLowerCase() !== name) throw elsewhere(wanted)
  }
  const other =
    writtenRepositories(question).find((candidate) => !same(candidate)) ??
    registered.find(
      (candidate) =>
        !same(candidate) &&
        candidate.split('/')[1]?.toLowerCase() !== name &&
        namesBare(question, candidate),
    )
  if (other) throw elsewhere(other)
  return repository
}

/**
 * The repository a Codex job may target. Only the owner's sentence picks it: a full name written
 * in it, or a bare name that matches exactly one checkout registered for this principal. When the
 * sentence names no repository, `recent` is meant: the caller passes the most recent job's
 * repository only when the owner wrote it or that job was Codex work. The model's argument can
 * only choose among these, never add to them.
 */
export function resolveCodexRepository(
  question: string,
  supplied: unknown,
  registered: readonly string[],
  recent: string | undefined,
): string {
  if (supplied !== undefined && (typeof supplied !== 'string' || !supplied.trim()))
    throw new TriggerAgentError(nameRepository)
  const written = writtenRepositories(question)
  const bare = registered.filter((repository) => namesBare(question, repository))
  const unique = bare.filter(
    (repository) =>
      bare.filter((other) => other.split('/')[1] === repository.split('/')[1]).length === 1,
  )
  const candidates =
    written.length || bare.length ? [...written, ...unique] : recent ? [recent] : []
  const wanted = typeof supplied === 'string' ? supplied.trim().toLowerCase() : undefined
  const matches = [
    ...new Map(
      candidates
        .filter(
          (candidate) =>
            wanted === undefined ||
            candidate.toLowerCase() === wanted ||
            (!wanted.includes('/') && candidate.split('/')[1].toLowerCase() === wanted),
        )
        .map((candidate) => [candidate.toLowerCase(), candidate]),
    ).values(),
  ]
  if (matches.length !== 1) throw new TriggerAgentError(nameRepository)
  return matches[0]
}

export function recentWorkAnswer(history: readonly TriggerConversationTurn[]) {
  return history.filter((turn) => turn.status === 'completed' && turn.answer !== null).slice(-8)
}
