import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Trial } from './engine'
import { comparePairs, renderReport } from './report'
import { Sandbox, gradeAgent } from './sandbox'
import { hash, loadSnapshot } from './snapshot'
import { getSuite } from './suites'

// Replay only stored virtual tool calls. No provider, credentials or real tools.
const [sourceArg, outputArg] = process.argv.slice(2)
if (!sourceArg || !outputArg) throw new Error('Usage: regrade-real.ts RUN_DIR NEW_OUTPUT_DIR')
const source = resolve(sourceArg)
const output = resolve(outputArg)
const baseline = loadSnapshot(resolve(source, 'baseline.json'))
const candidate = loadSnapshot(resolve(source, 'candidate.json'))
if (baseline.suite !== 'real' || candidate.suite !== 'real') throw new Error('Real replay only')
const cases = getSuite('real')
const raw = readFileSync(resolve(source, 'results.jsonl'), 'utf8')
const results = raw
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Trial)
const changes: unknown[] = []
for (const trial of results) {
  const fixture = cases.agent.find((entry) => entry.id === trial.caseId)
  if (!fixture || trial.status !== 'ok') continue
  if (fixture.background) throw new Error('Background replay not supported by this regrader')
  const sandbox = new Sandbox(fixture)
  for (const [index, observation] of trial.observations.entries()) {
    sandbox.execute({
      type: 'tool_use',
      id: String(index),
      name: observation.name,
      input: observation.input,
    })
    sandbox.takeFollowUp()
    const replayed = sandbox.observations.at(-1)
    if (replayed?.result !== observation.result || replayed.error !== observation.error)
      throw new Error(`Model-visible tool result changed: ${trial.id}; cannot rescore`)
  }
  const grade = gradeAgent(fixture, sandbox, trial.messages, trial.grade?.checks.finished === true)
  if (JSON.stringify(grade) !== JSON.stringify(trial.grade))
    changes.push({ id: trial.id, before: trial.grade, after: grade })
  trial.grade = grade
  trial.passed = grade.passed
  // Keep original observations unchanged as evidence of the original harness.
}
mkdirSync(output)
writeFileSync(
  resolve(output, 'results.jsonl'),
  `${results.map((r) => JSON.stringify(r)).join('\n')}\n`,
)
writeFileSync(resolve(output, 'report.md'), renderReport(results, baseline.label, candidate.label))
const audit = {
  source,
  rawResultsSha256: hash(raw),
  correctedResultsSha256: hash(readFileSync(resolve(output, 'results.jsonl'), 'utf8')),
  graderSha256: hash(readFileSync(resolve(import.meta.dir, 'sandbox.ts'), 'utf8')),
  regraderSha256: hash(readFileSync(import.meta.path, 'utf8')),
  changes,
  policy:
    'Only deterministic grading is replayed. Every model-visible tool response is identical; all original model messages, usage, timing and observations are retained.',
}
writeFileSync(resolve(output, 'audit.json'), `${JSON.stringify(audit, null, 2)}\n`)
console.log(
  JSON.stringify({
    changed: changes.length,
    pairs: comparePairs(results, baseline.label, candidate.label),
  }),
)
