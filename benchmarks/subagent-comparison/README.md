# Sub-Agent Comparison Benchmark

This benchmark runs real end-to-end sub-agent flows against the ZeRo OS runtime and compares:

- Legacy synchronous path: `task`
- Async path: `spawn_agent` + `wait_agent` + `send_input` + `close_agent`

The suite uses the real project config from `.zero/config.yaml`, resolves secrets from `.zero/secrets.enc` through `Vault`, and sends actual LLM requests through the configured providers.

## What It Measures

- Wall-clock latency per scenario
- Whether the scenario completed successfully
- Captured sub-agent output
- LLM call count, token usage, and estimated cost when trace data is available

## Models

By default the runner benchmarks both configured models:

- `claude-opus-4-6`
- `chatgpt/gpt-5.4`

## Scenarios

- `single-task`: one sub-agent lists and counts TypeScript files
- `parallel-tasks`: three independent tasks run in parallel
- `dependency-chain`: task B depends on task A output
- `mid-flight-input`: async-only scenario that injects extra input while the agent is running
- `error-recovery`: sub-agent is asked to read a missing file

## Prerequisites

- `.zero/config.yaml` must exist and contain the target model providers
- `.zero/secrets.enc` must be decryptable on this machine
- The vault master key must be available through macOS Keychain or `ZERO_MASTER_KEY_BASE64`
- Network access must be available to the configured model providers

## Run

From the project root:

```bash
bun run benchmarks/subagent-comparison/src/runner.ts
```

Examples:

```bash
bun run benchmarks/subagent-comparison/src/runner.ts --models=claude-opus-4-6
bun run benchmarks/subagent-comparison/src/runner.ts --scenarios=single-task,parallel-tasks
bun run benchmarks/subagent-comparison/src/runner.ts --runs=3
```

## CLI Options

- `--models=claude-opus-4-6,chatgpt/gpt-5.4`
- `--scenarios=all` or a comma-separated subset
- `--runs=1`

## Output

The runner writes artifacts under `benchmarks/subagent-comparison/results/`:

- `benchmark-<timestamp>.json`: raw benchmark results plus aggregated summary
- `benchmark-<timestamp>.md`: markdown summary table

It also prints live progress rows and a final summary table to the console.

## Interpreting Results

- Lower wall time is better for latency-sensitive parent-agent flows
- Higher `llmCalls`, `Tokens`, or `Est. Cost` can indicate orchestration overhead
- Scenario 4 has no legacy equivalent, so the legacy row is reported as `N/A`
- For the error scenario, compare how each path surfaces failure details rather than only the boolean success field

## Caveats

- LLM outputs are non-deterministic
- Provider latency and network conditions can dominate timings
- First-run cold starts can skew results
- Token and cost totals depend on trace availability and configured pricing
