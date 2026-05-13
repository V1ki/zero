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

Run the benchmark live:

```bash
bun run benchmarks/zero-runtime/src/cli.ts run \
  --models chatgpt/gpt-5.5,qwen-local/qwen3.6-27b,dashscope-token-plan/qwen3.6-plus
```

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
