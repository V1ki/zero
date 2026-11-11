import type { GithubInvestigation, TriggerPriorEvent } from '@zero-os/shared'

/** The four Router model judgements under test, each through its shipped entry point. */
export type Judgement = 'write_check' | 'triage' | 'job_report' | 'investigation'

export const JUDGEMENTS: Judgement[] = ['write_check', 'triage', 'job_report', 'investigation']

interface BaseCase {
  id: string
  /** One line: the distinction this case tests. Shown next to every failure. */
  purpose: string
}

/** Write check: from the owner's sentence alone, may Codex start or continue. */
export interface WriteCheckCase extends BaseCase {
  message: string
  kind: 'submit' | 'continue'
  repository: string
  jobId?: number
  chosenOption?: number
  expected: 'allow' | 'deny'
}

/** Triage: personal pipeline (earlier events of the stream) or mandate (purpose plus summaries). */
export interface TriageCase extends BaseCase {
  pipeline: 'personal' | 'mandate'
  mandatePurpose?: string
  previous: TriggerPriorEvent[]
  event: {
    source: 'github' | 'wxarc'
    scope: string
    title: string
    summary: string
    occurredAt: string
  }
  expected: 'notify' | 'skip'
}

/** Every listed group must match: at least one phrase of each group appears in the text. */
export type PhraseGroups = string[][]

export interface JobReportCase extends BaseCase {
  instruction: string
  brief?: string
  executor: 'zero' | 'codex'
  repository?: string
  result: string
  expect: {
    decision: 'required' | 'absent' | 'any'
    /** The verdict answers the question when every group has a phrase in it. */
    verdict?: PhraseGroups
    /** Labels coined during the work that must not reach the verdict. */
    verdictForbidden?: string[]
    /** For a result that says something important could not be verified. */
    caveat?: PhraseGroups
    /** For an analysis that changed nothing. */
    doneEmpty?: boolean
    /** Injected content: none of these may appear anywhere in the report. */
    injected?: string[]
  }
}

export type CannedTool = { facts: GithubInvestigation['facts'] } | { error: string }

export interface InvestigationCase extends BaseCase {
  mandatePurpose: string
  triage: string
  event: {
    kind: 'run' | 'pull'
    scope: string
    title: string
    summary: string
    occurredAt: string
  }
  /** Canned results of the shipped read-only actions. A run event always offers both actions. */
  tools: { inspect_github: CannedTool; compare_runs?: CannedTool }
  expect: {
    status: 'read' | 'unread'
    required?: PhraseGroups
    /** Phrases that would assert a cause the facts do not support. */
    unsupportedCause?: string[]
    /** Phrases that would mean an injected instruction was followed or passed on. */
    injected?: string[]
    /** Phrases that would turn an injected request into the owner's next step. */
    injectedNext?: string[]
    /** Other phrases that must not appear. */
    forbidden?: string[]
    next?: 'required' | 'absent' | 'any'
  }
}

export type AnyCase = WriteCheckCase | TriageCase | JobReportCase | InvestigationCase

export interface CaseSets {
  write_check: WriteCheckCase[]
  triage: TriageCase[]
  job_report: JobReportCase[]
  investigation: InvestigationCase[]
}

export interface Check {
  name: string
  ok: boolean
  detail?: string
  /** Set on a check whose failure is the judgement's dangerous error. */
  danger?: boolean
}

export interface TrialResult {
  judgement: Judgement
  caseId: string
  rep: number
  /** `error` is an infrastructure failure (provider error or timeout) and is not graded. */
  status: 'ok' | 'error'
  passed: boolean
  dangerous: boolean
  expected: string
  outcome: string
  checks: Check[]
  /** What the shipped code returned, after its own parsing and secret filtering. */
  output?: unknown
  modelCalls: number
  toolCalls?: string[]
  responseModels: string[]
  usage: { input: number; output: number }
  /** sha256 prefix of the system prompt the shipped code sent. */
  systemHash?: string
  durationMs: number
  error?: string
}
