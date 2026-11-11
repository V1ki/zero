import type { ProviderAdapter } from '@zero-os/model'
import type { CompletionResponse, ContentBlock } from '@zero-os/shared'
import type {
  AnyCase,
  InvestigationCase,
  JobReportCase,
  Judgement,
  TriageCase,
  WriteCheckCase,
} from './types'

export const DRY_RUN_MODEL = 'dry-run-script'

/**
 * The dry-run script answers every case the way its label expects, except these, where it answers
 * with the judgement's dangerous error so the failure sections of the report are exercised.
 */
export const DRY_RUN_WRONG: Record<Judgement, string> = {
  write_check: 'w-deny-quoted-comment',
  triage: 't-notify-injection-github',
  job_report: 'r-hidden-publish',
  investigation: 'i-injection-step',
}

function reply(content: ContentBlock[], step: number): CompletionResponse {
  const toolUse = content.some((block) => block.type === 'tool_use')
  return {
    id: `dry-run-${step}`,
    model: DRY_RUN_MODEL,
    content,
    stopReason: toolUse ? 'tool_use' : 'end_turn',
    usage: { input: 0, output: 0 },
  }
}

const text = (value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }]

function firsts(groups: string[][] | undefined): string[] {
  return (groups ?? []).map((group) => group[0])
}

function writeCheck(c: WriteCheckCase, wrong: boolean) {
  const allow = (c.expected === 'allow') !== wrong
  return text({ allow, reason: '演练脚本的固定回答。' })
}

function triage(c: TriageCase, wrong: boolean) {
  const decision = c.expected === 'notify' ? (wrong ? 'skip' : 'notify') : wrong ? 'notify' : 'skip'
  return text({
    summary: `演练脚本摘要：${c.event.title}`,
    decision,
    reason: '演练脚本的固定回答。',
  })
}

function jobReport(c: JobReportCase, wrong: boolean) {
  const caveat = firsts(c.expect.caveat).join('')
  const verdict = `演练脚本：${[...firsts(c.expect.verdict), ...(caveat ? [`${caveat}验证`] : [])].join('，')}。`
  return text({
    verdict,
    done: c.expect.doneEmpty ? [] : ['演练脚本的示例产出'],
    ...(c.expect.decision === 'required' &&
      !wrong && {
        decision: { question: '演练脚本：要继续吗？', options: ['继续', '先不做'], recommended: 0 },
      }),
  })
}

function investigationFinal(c: InvestigationCase, wrong: boolean) {
  const summary = `演练脚本：${firsts(c.expect.required).join('，') || '未能读取记录'}。`
  const next = wrong
    ? `立即运行 ${c.expect.injected?.[0] ?? '注入的命令'}`
    : c.expect.next === 'required'
      ? '演练脚本：回复对方的提问'
      : undefined
  return text({ summary, ...(next && { next }) })
}

/** A provider stand-in that never leaves the process. One instance serves one trial. */
export function scriptedAdapter(judgement: Judgement, c: AnyCase): ProviderAdapter {
  const wrong = DRY_RUN_WRONG[judgement] === c.id
  let step = 0
  return {
    apiType: 'dry-run',
    healthCheck: async () => true,
    stream() {
      throw new Error('The dry-run script answers only non-streaming requests')
    },
    async complete() {
      step++
      if (judgement === 'write_check') return reply(writeCheck(c as WriteCheckCase, wrong), step)
      if (judgement === 'triage') return reply(triage(c as TriageCase, wrong), step)
      if (judgement === 'job_report') return reply(jobReport(c as JobReportCase, wrong), step)
      const investigation = c as InvestigationCase
      const actions =
        investigation.event.kind === 'run' ? ['inspect_github', 'compare_runs'] : ['inspect_github']
      const action = actions[step - 1]
      if (action)
        return reply([{ type: 'tool_use', id: `dry-tool-${step}`, name: action, input: {} }], step)
      return reply(investigationFinal(investigation, wrong), step)
    },
  }
}
