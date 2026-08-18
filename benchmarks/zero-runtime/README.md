# Zero Runtime Benchmark

Benchmark for comparing model backends inside the real Zero runtime.

The benchmark is intentionally different from an API replay script:

- each live case creates a real `Session`
- execution goes through `Session.handleMessage()` and the normal `AgentLoop`
- Zero's native `Tracer` writes `trace.jsonl` and `run.log`
- results compare models on completion, tool behavior, trace health, artifacts, and interventions

## Phases

1. `compatibility`: small cases that expose model/backend compatibility issues.
2. `runtime`: real Zero session cases that require tools, trace reading, or controlled reasoning.
3. `artifact`: cases that must create inspectable files, not just claim success.
4. `expansion`: the place to add frozen historical-session cases over time.

## Commands

Preview the current matrix without calling any model:

```bash
bun run benchmarks/zero-runtime/src/cli.ts plan
```

Audit the physical byte distribution of persisted session logs:

```bash
bun run logs:storage-audit
bun run logs:storage-audit -- --percentile 90
bun run logs:storage-audit -- --session sess_20260707_0009_fei_55b4
bun run logs:storage-audit -- --format json
```

The audit reads a fixed snapshot of each selected file and never prints payload contents.
`run.log` is reported by exact event and normalized storage category; `trace.jsonl` is
reported independently by span kind and kind/status. Bytes are the complete physical JSONL
record size, including its line ending. They are not the isolated byte size of a nested
`request`, `response`, or tool-result field. `--percentile 90` applies the P90 threshold to
non-empty `run.log` and `trace.jsonl` candidates separately and includes ties.

The normalized `run.log` rollup uses five mutually exclusive buckets:
`llm_request.raw_request`, `trace.* mirror`, `tool_call.raw_result`, compaction diagnostics,
and other. Use the exact-event table to inspect entries grouped under other, such as
`llm_request.raw_response` and `tool_call.raw_input`.

Run the benchmark live:

```bash
bun run benchmarks/zero-runtime/src/cli.ts run \
  --models chatgpt/gpt-5.5,qwen-local/qwen3.6-27b,dashscope-token-plan/qwen3.6-plus
```

Run the offline compaction quality harness against the longest persisted sessions:

```bash
bun run compaction:quality --limit 10 --checkpoints 3
```

This reads `.zero/logs/sessions.db` in readonly mode, samples 3-5 checkpoints per long
session, projects the current compaction history into a temporary artifact directory, and
writes `summary.json` plus `report.md` under `benchmarks/zero-runtime/results/`. The score is
a model-free proxy: it compares exact paths, URLs, tool arguments, and other terms reused by
the next historical turn against the compacted prompt projection. It is meant to catch
context-loss risk before paying for full model replay.

The report also includes a Saving vs Score table (checkpoints bucketed by prompt saving) so
variants are compared at matched compression levels, and a noise column: the share of
degraded (`summary`/`status`) tool_result chars in the projection that contain no oracle
term, i.e. dead weight kept after truncation. The offline compactor stub injects only a
small, realistic number of terms into its summaries, so scores reflect what the deterministic
pipeline retains rather than term-extraction leakage from the stub.

Run the independent, read-only compaction harness against a frozen trace prefix:

```bash
bun run compaction:harness-eval \
  --session sess_20260707_0009_fei_55b4 \
  --repeat 2
```

This path does not instantiate the normal Agent or write back to the source session. It streams
`trace.jsonl`, collapses lifecycle snapshots by span, projects bounded typed observations, keeps
error intervals and classified potential side effects, and produces a validated trace-diagnostic
checkpoint plus a full change-point ledger. Raw request, response, input, output, and evidence
payloads are represented only by counts and digests. The evaluator also binds the dry run to the
current canonical message revision and active compaction-block heads when `sessions.db` is
available, reports candidate and ledger bytes together, and verifies deterministic replay.

This is deliberately a trace-sidecar evaluation. It does **not** claim that the candidate can
replace canonical session messages, and it does not measure future-answer semantic quality. A
semantic compaction worker must separately consume a frozen message prefix, previous checkpoints,
and the uncompacted tail, then run goal/constraint/decision/evidence-handle recall tests.

Run the prompt-variant benchmark with official DeepSeek v4 flash:

```bash
bun run compaction:prompt-bench --limit 10 --reps 3 --concurrency 3
```

This selects one handle-heavy sample from each long session, then runs 10 Chinese prompt
variants three times per session. The report ranks variants by exact handle recall, future
tool-argument recall, compact score, and stability. By default it reads `deepseek_api_key`
from the local Zero vault; use `--secret-source env` to read `ZERO_BENCH_SECRET_DEEPSEEK_API_KEY`
instead.

Run the tool IO digest benchmark with official DeepSeek v4 flash:

```bash
bun run compaction:tool-io-digest --limit 10 --samples 6 --concurrency 3
```

This extracts large real `tool_use` + `tool_result` pairs from long sessions, then compares
single-tool versus consecutive-tool-group environment digest prompts. The benchmark is for
testing whether a pre-compaction digest can replace raw tool IO in the main prompt while
preserving exact paths, URLs, IDs, filenames, command flags, and other handles. The digest
prompt intentionally omits full conversation context and does not ask the model to explain why
a tool was called; at this layer the digest only summarizes local environment observations.

For local vLLM artifact-heavy runs, use a larger timeout such as
`--timeout-ms 360000`.

By default the runner reads `.zero/config.yaml`, writes runs under
`.zero/benchmarks/zero-runtime/runs`, merges the benchmark-only model overlay from
`benchmarks/zero-runtime/config/models.yaml`, and loads secrets from environment variables.
Secret environment variables are derived from config refs:

```text
ZERO_BENCH_SECRET_<REF_UPPER_SNAKE>
```

For example, `openai_codex_api_key` maps to:

```text
ZERO_BENCH_SECRET_OPENAI_CODEX_API_KEY
```

Use `--secret-source vault` to read the local Zero vault via the normal keychain path.
Do not use this in shared automation unless the machine is explicitly trusted.

## Benchmark-Only Models

`config/models.yaml` is a temporary model overlay for benchmark runs. It uses the same
provider/model shape as `.zero/config.yaml`, but it is only loaded by this runner and does
not change the real Zero runtime model list.

The default overlay includes:

```text
qwen-local/qwen3.6-27b
dashscope-token-plan/qwen3.6-plus
```

`qwen-local/qwen3.6-27b` points at the four-GPU vLLM server:

```text
http://172.18.8.200:8100/v1
```

It also sets `extra_body.chat_template_kwargs.enable_thinking=false` so the
OpenAI-compatible adapter receives final `content` instead of Qwen reasoning-only output.

The Token Plan model uses Token Plan's OpenAI-compatible endpoint with this secret ref:

```text
qwen_token_plan_api_key
```

Use `--model-config <path>` to load a different overlay, or `--model-config none` to
disable benchmark-only models.

## Output Layout

```text
.zero/benchmarks/zero-runtime/runs/<run-id>/
  plan.json
  summary.json
  report.md
  <case-id>/<model-id>/
    result.json
    logs/
      sessions/<date>/<session-id>/trace.jsonl
      sessions/<date>/<session-id>/run.log
    .zero/workspace/<agent-name>/
```

## Adding Cases

Add new cases in `src/cases.ts`. A useful case should define:

- the user prompt
- allowed tools
- expected artifacts, if any
- trace requirements
- final text expectations
- category and phase

Keep success criteria mechanical. Use `qualityRubric` for human or judge-model scoring.

## Current Scope

The first batch is deliberately small:

- no-tool boundary following
- plan-only boundary following
- trace/log diagnostic behavior
- HTML artifact creation and validation

This gives us a clean base before adding longer historical sessions.
