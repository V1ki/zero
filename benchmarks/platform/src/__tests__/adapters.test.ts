import { expect, test } from 'bun:test'
import type { Trial } from '../../../zero-runtime/src/prompt-bench/engine'
import type { BenchmarkSummary } from '../../../zero-runtime/src/types'
import { importCompaction, importPrompt, importRuntime } from '../adapters/legacy'
import { summarize } from '../report'

function prompt(status: Trial['status'] = 'ok'): Trial {
  return {
    id: 'test',
    model: 'test/model',
    variant: 'before',
    snapshotHash: 'prompt-sha',
    caseId: 'case',
    rep: 1,
    status,
    passed: status === 'ok',
    durationMs: 20,
    usage: { input: 10, output: 5 },
    requests: 2,
    responseModels: ['model'],
    messages: [],
    observations: [
      {
        name: 'read',
        input: { password: 'sensitive-marker' },
        result: 'private-marker',
        error: false,
      },
    ],
  }
}

test('prompt import retains tool counts but never exports payloads or invents missing timing/caches', () => {
  const rows = importPrompt([prompt()], '/source/results.jsonl', 'sha')
  expect(rows[0].measurements.execution.toolCalls).toBe(1)
  expect(rows[0].measurements.execution.tools.read.durationMs).toBeNull()
  expect(rows[0].measurements.execution.usage.cacheRead).toBeNull()
  expect(rows[0].measurements.evaluation.modelCalls).toBeNull()
  expect(JSON.stringify(rows)).not.toContain('sensitive-marker')
  expect(JSON.stringify(rows)).not.toContain('private-marker')
  expect(summarize(rows)[0].accepted).toBe(1)
  expect(rows[0].case.sourceGroup).toBe('legacy-batch:sha')
})

test('timeout placeholder zeros in old runner are imported as unknown, not free', () => {
  const trial = prompt('timeout')
  trial.usage = { input: 0, output: 0 }
  trial.requests = 0
  const rows = importPrompt([trial], '/source/results.jsonl', 'sha')
  expect(rows[0].measurements.execution.usage.input).toBeNull()
  expect(rows[0].measurements.execution.modelCalls).toBeNull()
  expect(summarize(rows)[0].accepted).toBe(0)
  expect(summarize(rows)[0].trials).toBe(1)
})

test('runtime import preserves validation scope and refuses an unqualified legacy cost', () => {
  const summary: BenchmarkSummary = {
    runId: 'test',
    generatedAt: 'test',
    plan: [],
    results: [
      {
        caseId: 'html',
        model: { id: 'm', label: 'm', model: 'test/model' },
        status: 'success',
        startedAt: 'test',
        endedAt: 'test',
        durationMs: 20,
        runDir: '/run',
        workspace: '/run/work',
        finalText: 'private-marker',
        messages: [],
        trace: {
          rawEntryCount: 10,
          collapsedEntryCount: 5,
          llmRequestCount: 2,
          toolCallCount: 1,
          toolErrorCount: 0,
          closureFailedCount: 0,
          turnSuccessCount: 1,
          stopReasons: {},
          toolNames: { read: 1 },
          inputTokens: 100,
          outputTokens: 10,
          reasoningTokens: 5,
          cacheReadTokens: 20,
          cost: 0.2,
        },
        validation: { ok: true, checks: [{ name: 'artifact-exists', passed: true }] },
      },
    ],
  }
  const rows = importRuntime(summary, '/source/summary.json', 'sha')
  expect(rows[0].environment.mode).toBe('controlled')
  expect(rows[0].measurements.execution.modelCalls).toBe(2)
  expect(rows[0].measurements.execution.costs).toEqual([])
  expect(rows[0].measurements.execution.unknownCostOperations).toBeNull()
  expect(summarize(rows)[0].accepted).toBe(1)
  expect(JSON.stringify(rows)).not.toContain('private-marker')
})

test('compaction proxy metrics do not turn parse success into semantic acceptance', () => {
  // Full shape of an old summary.json, including fields the importer ignores.
  const summary = {
    generatedAt: 'test',
    dbPath: '/source.db',
    model: 'test/model',
    options: { sessionLimit: 1, reps: 1, concurrency: 1, maxTokens: 100 },
    variants: [{ id: 'v1', title: 'test', hypothesis: 'test', instruction: 'private-marker' }],
    samples: [],
    summaries: [],
    results: [
      {
        variantId: 'v1',
        variantTitle: 'test',
        rep: 1,
        sessionId: 'session',
        model: 'test/model',
        parseOk: true,
        validationStatus: 'pass',
        topicCount: 1,
        missingToolRefCount: 0,
        compactScore: 95,
        accuracyLossPercent: 2,
        exactHandleScore: 98,
        futureToolArgScore: 97,
        oracleTermCount: 10,
        exactHandleTermCount: 5,
        futureToolArgTermCount: 5,
        missingExamples: ['private-marker'],
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 20,
        promptChars: 100,
        responseChars: 50,
      },
    ],
  }
  const rows = importCompaction(summary, '/source/summary.json', 'sha')
  expect(rows[0].evaluation?.verdict).toBe('needs_review')
  expect(rows[0].measurements.execution.modelCalls).toBeNull()
  expect(rows[0].measurements.execution.usage.cacheRead).toBeNull()
  const group = summarize(rows)[0]
  expect(group.accepted).toBe(0)
  expect(group.qualityMetrics.find((m) => m.id === 'compact-score')?.values.median).toBe(95)
  expect(JSON.stringify(rows)).not.toContain('private-marker')
})
