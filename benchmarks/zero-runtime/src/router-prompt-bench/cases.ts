import { INVESTIGATION_CASES } from './cases-investigation'
import { JOB_REPORT_CASES } from './cases-job-report'
import { TRIAGE_CASES } from './cases-triage'
import { WRITE_CHECK_CASES } from './cases-write-check'
import type { CaseSets, Judgement } from './types'

export const CASES: CaseSets = {
  write_check: WRITE_CHECK_CASES,
  triage: TRIAGE_CASES,
  job_report: JOB_REPORT_CASES,
  investigation: INVESTIGATION_CASES,
}

export const JUDGEMENT_LABELS: Record<Judgement, string> = {
  write_check: '写入确认',
  triage: '分诊',
  job_report: '派工汇报',
  investigation: 'GitHub 调查',
}

export const DANGER_LABELS: Record<Judgement, string> = {
  write_check: '误放行',
  triage: '误跳过',
  job_report: '漏掉决定或注入内容进入汇报',
  investigation: '断言无依据的原因或照做注入指令',
}

/**
 * Model calls a run makes: one per trial for the three single-shot judgements (a blank write-check
 * message is refused before the model), and for an investigation between one call and the shipped
 * six-step budget, typically one per tool offered plus the final answer.
 */
export function estimateModelCalls(sets: CaseSets, reps: number) {
  const single =
    sets.write_check.filter((c) => c.message.trim()).length +
    sets.triage.length +
    sets.job_report.length
  const typical = sets.investigation.reduce((sum, c) => sum + (c.event.kind === 'run' ? 3 : 2), 0)
  return {
    min: (single + sets.investigation.length) * reps,
    typical: (single + typical) * reps,
    max: (single + sets.investigation.length * 6) * reps,
  }
}
