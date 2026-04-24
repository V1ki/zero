# ZeRo OS

[中文文档](./README.zh-CN.md)

ZeRo OS is a Bun + TypeScript monorepo for running a persistent agent runtime with tools,
memory, observability, scheduling, channel adapters, a Web control plane, and an optional
supervisor process.

It is not just a chat UI. The repository is organized around a runtime that can:

- route requests across configured model providers
- persist sessions, logs, metrics, traces, and long-term memory
- expose a browser-based control plane over HTTP + WebSocket
- connect the runtime to Web, Telegram, and Feishu channels
- schedule work with cron-style jobs
- monitor liveness and attempt repair through a supervisor loop

## What Lives Here

- `apps/server`: the main CLI and runtime bootstrap
- `apps/web`: the Hono + Bun server plus the React control plane
- `apps/supervisor`: the heartbeat monitor and restart loop
- `packages/*`: the reusable runtime, model, memory, channel, scheduler, observability, and
  shared domain modules
- `e2e/*`: Playwright end-to-end coverage for the operator-facing workflows

## Architecture

### Runtime Layers

- `packages/shared` provides the system contracts, config types, message schemas, and common
  utilities used across the monorepo.
- `packages/secrets` manages the encrypted vault and output secret filtering.
- `packages/model` resolves providers, adapters, auth strategies, and model selection.
- `packages/memory` stores Markdown-backed memory, memo state, vector indexes, and retrieval
  logic.
- `packages/observe` persists logs, metrics, traces, session state, and schedule state.
- `packages/core` assembles the agent loop, tools, sessions, and bootstrap context.
- `packages/channel` adapts the runtime to WebSocket, Telegram, and Feishu message flows.
- `packages/scheduler` runs cron-style jobs and hands trigger execution back to the runtime.
- `packages/supervisor` watches liveness and provides repair helpers and git-based recovery
  primitives.
- `apps/*` turn those modules into runnable processes.

### Process Topology

1. `bun zero start` enters the CLI in `apps/server/src/cli.ts`.
2. The CLI initializes the ZeRo OS runtime in `apps/server/src/main.ts`.
3. The runtime loads config, secrets, tools, model routing, memory, observability, sessions,
   channels, and the scheduler.
4. The Web server in `apps/web/src/server.ts` mounts HTTP APIs, serves the built SPA, and
   exposes a WebSocket bridge for real-time events.
5. The optional supervisor in `apps/supervisor/src/main.ts` watches `.zero/heartbeat.json`
   and rebuilds/restarts the main process if the heartbeat goes stale.

### Request Flow

1. An incoming message enters from Web, Telegram, or Feishu.
2. The channel layer normalizes the payload into shared runtime message types.
3. `SessionManager` finds or creates the bound session.
4. The agent builds prompt context from config, bootstrap files, session history, and memory.
5. `ModelRouter` selects the configured model/provider.
6. The tool loop can read/write files, read local images, execute fused shell commands,
   fetch URLs, recall memory, and create schedules.
7. Logs, traces, metrics, and session state are written through the observability layer.
8. The final response is sent back through the originating channel.

## Runtime State

ZeRo OS keeps local operational state under `.zero/`. This directory is runtime data, not
product source.

- `.zero/config.yaml`: system config for providers, models, channels, schedules, and optional
  embedding settings
- `.zero/secrets.enc`: encrypted secret vault
- `.zero/fuse_list.yaml`: safety rules for shell execution
- `.zero/memory/**`: long-term memory files
- `.zero/workspace/**`: bootstrap files and agent workspace state
- `.zero/logs/**`: observability data, including `events.jsonl`, metrics, and per-session traces
- `.zero/heartbeat.json`: liveness signal for supervisor/restart flows

Do not commit `.zero/`, `dist/`, `node_modules/`, or `test-results/`.

## Requirements

- Bun
- macOS for the current default secret-management flow

The secret layer uses the macOS `security` CLI and stores the master key in Keychain.
`launchctl` integration is also macOS-specific. The rest of the codebase is largely portable,
but the default operational path in this repo assumes macOS.

## Quick Start

### 1. Install dependencies

```bash
bun install
```

### 2. Initialize local state

```bash
bun zero init
```

This creates the local runtime directory, generates or loads the master key, initializes the
encrypted vault, and writes default bootstrap files into `.zero/workspace/zero/`.

If you want to store the primary API key during init:

```bash
bun zero init <your-api-key>
```

Or later:

```bash
bun zero secret set openai_codex_api_key <your-api-key>
```

### 3. Create `.zero/config.yaml`

`bun zero init` does not create the runtime config file. `bun zero start` will fail until
`.zero/config.yaml` exists.

Minimal example:

```yaml
providers:
  openai:
    api_type: openai_chat_completions
    base_url: https://api.openai.com/v1
    auth:
      type: api_key
      api_key_ref: openai_codex_api_key
    models:
      gpt5:
        model_id: gpt-5.4
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
          - reasoning
        tags:
          - primary
default_model: openai/gpt5
fallback_chain:
  - openai/gpt5
channels:
  - name: web
    type: web
    enabled: true
    receive_notifications: true
```

Optional files:

- `.zero/fuse_list.yaml` for shell safety rules
- embedding config inside `.zero/config.yaml` if you want vector-backed memory retrieval
- additional channel definitions for Telegram or Feishu

### 4. Build the Web UI

```bash
bun run build:web
```

The runtime serves the built SPA from `apps/web/dist`. If the UI is not built, the server
will return a message telling you to run the build step.

### 5. Start ZeRo OS

```bash
bun zero start
```

By default the UI and API are served on `http://localhost:3001`.

Useful endpoints:

- `GET /api/status`: health/status probe
- `GET /api/sessions`: session listing
- `GET /api/models`: available models
- `WS /ws`: realtime event bridge for the control plane

## Web Control Plane

The operator UI is a React app hosted by the Bun server. It covers:

- dashboard and runtime health
- sessions and deep session inspection
- memory and memo management
- tool registry visibility
- logs and metrics
- config and provider status
- realtime updates over WebSocket

The front end uses Vite, React 19, TanStack Router, TanStack Query, Zustand, Hono, and
Recharts.

## CLI

Primary entrypoint:

```bash
bun zero <command>
```

Useful commands:

```bash
bun zero start
bun zero restart
bun zero status
bun zero logs all --follow
bun zero secret set <key> <value>
bun zero secret list
bun zero secret delete <key>
bun zero launchctl install
bun zero launchctl status
bun zero launchctl uninstall
```

Agent-visible Zero command guidance lives in `docs/zero-cli.md`. Treat that file as the
controlled command surface for `bun zero ...` operations.

ChatGPT OAuth sessions now refresh on demand before expiry and after a single 401 recovery attempt. Re-run `bun zero provider login chatgpt` only if the refresh token has been invalidated or expired.

Claude browser OAuth is also available through the same managed callback flow. ZeRo OS stores the Claude credential in the vault as session JSON, resolves the access token at runtime, and refreshes the session automatically until the refresh grant is no longer valid. Re-run `bun zero provider login anthropic` only when Claude asks for re-authentication.

## Development Workflow

### Day-to-day commands

```bash
bun run dev:web
bun run build:web
bun run check
bun run lint
bun run lint:fix
bun run test
bun run test:e2e
```

### Validation expectations

- `bun run check`: TypeScript baseline
- `bun run lint`: Biome lint and formatting validation
- `bun run test`: recursive Bun tests across `packages/*` and `apps/*`
- `bun run test:e2e`: Playwright E2E against `http://localhost:3001`

The Playwright configuration automatically starts `bun zero start` and waits for
`http://localhost:3001/api/status`. The E2E suite currently targets Chromium.

## Test Coverage Shape

The repository already has broad automated coverage around both the runtime and the operator
experience.

- unit and integration tests cover agent behavior, tool recovery, budgeting, config parsing,
  model routing, session lifecycle, memory retrieval, observability, scheduler behavior, and
  channel adapters
- Playwright E2E covers navigation, dashboard widgets, sessions, session detail, memory,
  memo editing, tools, logs, metrics, config CRUD, notifications, responsive layout,
  skeleton states, error boundaries, streaming chat, and WebSocket-driven UI behavior

This means the repo is already set up to treat the Web console and runtime APIs as a real
regression surface, not just a demo shell.

## Repo Layout

```text
apps/
  server/       CLI, runtime bootstrap, channel wiring, startup path
  web/          API routes, WebSocket bridge, React operator UI
  supervisor/   heartbeat monitor and repair loop
packages/
  shared/       shared types and utilities
  secrets/      encrypted vault and secret filtering
  model/        provider adapters, auth, model routing
  memory/       long-term memory store and retrieval
  observe/      logs, metrics, trace, session persistence
  core/         agent runtime, tool loop, sessions, bootstrap loading
  channel/      Web, Telegram, Feishu adapters
  scheduler/    cron-style task scheduling
  supervisor/   repair engine, heartbeat utilities, git ops
e2e/            Playwright end-to-end coverage
.zero/          local runtime state, memory, logs, secrets, workspace
```

## Notes on Safety and Operations

- secrets are filtered before they are written to logs or emitted in tool/model output
- shell execution is guarded by fuse-list rules
- long-term memory is stored as local files under `.zero/memory`
- schedule state and session state are persisted through the observability layer, with global
  events in `.zero/logs/events.jsonl` and append-only session execution trace snapshots in
  `.zero/logs/sessions/<date>/<session>/trace.jsonl`
- `events.jsonl` is a curated stream of key operational/session events rather than a full mirror
  of every internal bus event
- key session-scoped events may include `sessionId` and `spanId` so they can be correlated back
  to the persisted trace
- the supervisor is optional for local development, but it is the intended path for
  self-healing restart behavior

## Workspace Summary

At a high level, `apps/*` contains runnable entrypoints, `packages/*` contains the runtime
capabilities, and `e2e/*` defines the user-visible regression baseline for the system.
