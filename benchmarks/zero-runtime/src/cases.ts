import { join } from 'node:path'
import type { BenchmarkCase, PromptVars } from './types'

export const benchmarkCases: BenchmarkCase[] = [
  {
    id: 'compat-no-tools-boundary',
    title: 'Compatibility: no-tool instruction boundary',
    phase: 'compatibility',
    category: 'instruction-following',
    description: 'Checks whether the model can answer directly without inventing tool work.',
    allowedTools: [],
    agentInstruction:
      'You are a Zero Runtime Benchmark subject. Follow the user instruction exactly and answer in Chinese.',
    userPrompt:
      '不要调用任何工具。用两句话说明 Zero Runtime Benchmark 在对比 GPT-5.5 和自部署 Qwen 时应该测什么。',
    validation: {
      disallowTools: true,
      finalTextIncludes: ['Zero', 'Qwen'],
      requiredTraceKinds: ['snapshot', 'turn', 'llm_request'],
    },
    qualityRubric: [
      {
        key: 'scope',
        maxScore: 3,
        description: 'Mentions real runtime behavior, tools, trace, and outcome quality.',
      },
      {
        key: 'boundary',
        maxScore: 2,
        description: 'Does not suggest extra execution or optional branches.',
      },
    ],
    timeoutMs: 120_000,
    tags: ['baseline', 'no-tools'],
  },
  {
    id: 'runtime-plan-boundary',
    title: 'Runtime: planning-only boundary',
    phase: 'runtime',
    category: 'user-boundary',
    description: 'Checks whether the model respects "do not code yet" planning boundaries.',
    allowedTools: [],
    agentInstruction:
      'You are a Zero Runtime Benchmark subject. Respect explicit user boundaries. Answer in Chinese.',
    userPrompt:
      '先不要编码。请规划一个逐步扩展的模型 Benchmark，目标是对比 GPT-5.5 与四卡自部署 Qwen 在当前 Zero 中真实运行的差距。',
    validation: {
      disallowTools: true,
      finalTextIncludes: ['Benchmark', 'Qwen', 'GPT'],
      finalTextExcludes: ['已修改', '已创建文件'],
      requiredTraceKinds: ['snapshot', 'turn', 'llm_request'],
    },
    qualityRubric: [
      {
        key: 'plan_quality',
        maxScore: 5,
        description: 'Clear phases, fair A/B rules, and native trace requirements.',
      },
    ],
    timeoutMs: 120_000,
    tags: ['planning', 'boundary'],
  },
  {
    id: 'runtime-trace-diagnosis',
    title: 'Runtime: trace/log diagnosis',
    phase: 'runtime',
    category: 'tool-use',
    description:
      'Requires inspecting frozen trace/run-log fixtures and distinguishing main-answer success from later closure failure.',
    allowedTools: ['read', 'bash'],
    agentInstruction:
      'You are a careful Zero runtime investigator. Use local evidence before answering. Answer in Chinese.',
    userPrompt: `读取并分析这个 fixture session：

trace: {{fixtureDir}}/session-mini/trace.jsonl
run log: {{fixtureDir}}/session-mini/run.log
summary: {{fixtureDir}}/session-mini/sessions-summary.json

请说明这个 session 做了什么、主回复是否已经完成、后面是否还有失败，以及失败属于哪一类。不要泛泛猜测。`,
    validation: {
      minToolCalls: 1,
      requiredToolNames: ['read'],
      finalTextIncludes: ['closure_failed', '主', '完成'],
      requiredTraceKinds: ['snapshot', 'turn', 'llm_request', 'tool_call'],
    },
    qualityRubric: [
      {
        key: 'evidence',
        maxScore: 4,
        description: 'Grounds the answer in trace/log facts instead of generic diagnosis.',
      },
      {
        key: 'failure_separation',
        maxScore: 3,
        description: 'Separates main reply completion from later closure-classifier failure.',
      },
    ],
    timeoutMs: 180_000,
    tags: ['trace', 'logs', 'tools'],
  },
  {
    id: 'artifact-html-scorecard',
    title: 'Artifact: HTML scorecard',
    phase: 'artifact',
    category: 'artifact-generation',
    description:
      'Requires creating an inspectable HTML artifact rather than only claiming the work is done.',
    allowedTools: ['write', 'read', 'bash'],
    agentInstruction:
      'You are a Zero artifact benchmark subject. Create the requested local artifact and then summarize it in Chinese.',
    userPrompt: `创建一个 HTML 评分卡文件：

{{artifactDir}}/model-scorecard.html

内容用于对比 GPT-5.5 与自部署 Qwen 在 Zero Runtime Benchmark 中的表现。页面必须包含这些词：GPT-5.5、Qwen、trace、tool calling、artifact。完成后回复文件路径和关键内容摘要。`,
    validation: {
      minToolCalls: 1,
      requiredToolNames: ['write'],
      finalTextIncludes: ['model-scorecard.html'],
      expectedArtifacts: [
        {
          path: '{{artifactDir}}/model-scorecard.html',
          minBytes: 300,
          contains: ['<html', 'GPT-5.5', 'Qwen', 'trace', 'tool calling', 'artifact'],
        },
      ],
      requiredTraceKinds: ['snapshot', 'turn', 'llm_request', 'tool_call'],
    },
    qualityRubric: [
      {
        key: 'artifact_usefulness',
        maxScore: 5,
        description: 'Artifact is inspectable, on-topic, and could support benchmark reporting.',
      },
    ],
    timeoutMs: 180_000,
    tags: ['artifact', 'html', 'write'],
  },
]

export function selectCases(ids: string[]): BenchmarkCase[] {
  if (ids.length === 0) return benchmarkCases
  const requested = new Set(ids)
  return benchmarkCases.filter((benchCase) => requested.has(benchCase.id))
}

export function interpolateTemplate(template: string, vars: PromptVars): string {
  return template
    .replaceAll('{{artifactDir}}', vars.artifactDir)
    .replaceAll('{{fixtureDir}}', vars.fixtureDir)
    .replaceAll('{{projectRoot}}', vars.projectRoot)
    .replaceAll('{{runDir}}', vars.runDir)
    .replaceAll('{{workspace}}', vars.workspace)
}

export function buildPromptVars(runDir: string, agentName: string): PromptVars {
  const workspace = join(runDir, '.zero', 'workspace', agentName)
  return {
    artifactDir: join(workspace, 'artifacts'),
    fixtureDir: join(process.cwd(), 'benchmarks', 'zero-runtime', 'fixtures'),
    projectRoot: runDir,
    runDir,
    workspace,
  }
}
