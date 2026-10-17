import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PromptComponents } from '@zero-os/shared'
import { TOOLS } from './cases'
import { type SuiteName, getSuite } from './suites'

export function hash(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
}

export function suiteHash(suite: SuiteName = 'basic'): string {
  const { agent, closure } = getSuite(suite)
  return hash({ version: 1, agent, closure, tools: TOOLS })
}

export interface Snapshot {
  schema: 1
  suite?: SuiteName
  label: string
  suiteHash: string
  source: string
  commit: string
  sourceHashes: Record<string, string>
  systems: Record<'full' | 'minimal', string>
  closureSystem: string
  closurePrompts: Record<string, string>
  hash: string
}

const SOURCES = [
  'packages/core/src/agent/prompt.ts',
  'packages/core/src/agent/task-closure.ts',
  'packages/core/src/agent/budget.ts',
  'packages/core/src/agent/params.ts',
  'packages/core/src/bootstrap/loader.ts',
  'packages/core/src/bootstrap/templates.ts',
]

export async function captureSnapshot(
  root: string,
  label: string,
  ref = 'working-tree',
  suite: SuiteName = 'basic',
): Promise<Snapshot> {
  const cases = getSuite(suite)
  const temp = mkdtempSync(join(tmpdir(), 'zero-prompt-snapshot-'))
  try {
    symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir')
    const sourceHashes: Record<string, string> = {}
    for (const path of SOURCES) {
      const content =
        ref === 'working-tree'
          ? readFileSync(join(root, path), 'utf8')
          : execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' })
      sourceHashes[path] = hash(content)
      mkdirSync(dirname(join(temp, path)), { recursive: true })
      writeFileSync(join(temp, path), content)
    }
    // Shared token helpers are the current harness dependency; record their exact version too.
    sourceHashes['packages/shared/src/utils/tokens.ts'] = hash(
      readFileSync(join(root, 'packages/shared/src/utils/tokens.ts'), 'utf8'),
    )
    const prompt = (await import(pathToFileURL(join(temp, SOURCES[0])).href)) as {
      buildSystemPrompt: (components: PromptComponents) => string
    }
    const closure = (await import(pathToFileURL(join(temp, SOURCES[1])).href)) as {
      TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT: string
      buildTaskClosureDecisionPrompt: (
        user: string,
        assistant: string,
        context: { toolSummary: string },
        queued?: string,
      ) => string
    }
    const templates = (await import(pathToFileURL(join(temp, SOURCES[5])).href)) as {
      DEFAULT_TEMPLATES: Record<string, string>
    }
    const components: PromptComponents = {
      agentName: 'zero-benchmark',
      agentDescription: '你是 ZeRo OS，帮助用户完成当前任务。',
      tools: TOOLS,
      globalIdentity: '',
      agentIdentity: '',
      workspacePath: '/benchmark',
      projectRoot: '/benchmark',
      runtimeInfo: { channel: 'web', model: 'BENCH_MODEL', os: 'macOS', shell: 'zsh' },
    }
    const systems = Object.fromEntries(
      (['full', 'minimal'] as const).map((mode) => [
        mode,
        prompt.buildSystemPrompt({
          ...components,
          promptMode: mode,
          bootstrapFiles: Object.entries(templates.DEFAULT_TEMPLATES)
            .filter(([name]) => mode === 'full' || name === 'TOOLS.md')
            .map(([name, content]) => ({ name, path: `/benchmark/${name}`, content })),
        }),
      ]),
    ) as Snapshot['systems']
    const body: Omit<Snapshot, 'hash'> = {
      schema: 1,
      ...(suite === 'basic' ? {} : { suite }),
      label,
      suiteHash: suiteHash(suite),
      source: ref,
      commit: execFileSync('git', ['rev-parse', ref === 'working-tree' ? 'HEAD' : ref], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      sourceHashes,
      systems,
      closureSystem: closure.TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT,
      closurePrompts: Object.fromEntries(
        cases.closure.map((c) => [
          c.id,
          closure.buildTaskClosureDecisionPrompt(
            c.user,
            c.assistant,
            { toolSummary: c.tools },
            c.queued,
          ),
        ]),
      ),
    }
    return { ...body, hash: hash(body) }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

export function loadSnapshot(path: string): Snapshot {
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot
  const { hash: checksum, ...body } = snapshot
  if (snapshot.schema !== 1 || checksum !== hash(body))
    throw new Error(`Invalid snapshot checksum: ${path}`)
  if (snapshot.suiteHash !== suiteHash(snapshot.suite))
    throw new Error('Fixture suite changed: recapture both snapshots with the same suite')
  return snapshot
}
