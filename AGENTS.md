# AGENTS.md

## Project
ZeRo OS monorepo built with Bun + TypeScript.

## Mission
- Deliver working, minimal, testable changes.
- Prefer small, behavior-safe diffs over broad refactors.
- Preserve runtime stability for server, websocket, session, tool, and chat flows.
- Default to completing the requested change end-to-end in one pass: explore, implement, verify, and summarize.

## Agent Operating Model
- Be autonomous, but not reckless: make reasonable assumptions and move forward unless truly blocked.
- Do the work, not just the plan. Avoid stopping after analysis when implementation is feasible.
- Prefer fixing root causes over patching symptoms.
- Stay scoped to the user's request. Do not opportunistically refactor unrelated areas.
- If you notice unexpected unrelated changes in files you need to touch, stop and ask before proceeding.

## Tech Stack
- Runtime/package manager: **Bun**
- Language: **TypeScript (ESM)**
- Monorepo: workspaces in `apps/*`, `packages/*`
- Web: Vite + React + Hono + Bun.serve
- E2E: Playwright
- Lint/format: Biome

## Repository Map
- `apps/server`: ZeRo OS bootstrap, CLI, runtime (`src/cli.ts`, `src/main.ts`)
- `apps/web`: UI and API/web server integration (`src/server.ts`)
- `apps/supervisor`: supervisor app entry
- `packages/core|model|memory|observe|secrets|channel|scheduler|supervisor|shared`: domain modules
- `e2e`: end-to-end tests
- `.zero`: local runtime state (logs, memory, secrets, workspace) — treat as operational data, not product source

## Vendored Reference Sources
- `repos/` holds vendored upstream source repos kept as **read-only reference material**, not application code.
- Current: `repos/effect` = the Effect-TS monorepo at tag `effect@3.22.1`, pinned to match the installed `effect` dependency.
- When writing Effect code, read the real source and tests under `repos/effect/packages/effect/` instead of guessing APIs or searching the web; verify every API against the source before using it.
- Never edit files under `repos/` unless explicitly asked.
- Never import from `repos/` — application code imports from normal package dependencies (e.g. `import { Effect } from 'effect'`).
- To update the reference: `git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<installed-version> --squash`, keeping the tag in sync with the installed version.

## Critical Safety Rules
1. Never print, paste, or commit secret values.
2. Never modify `.zero/secrets.enc` by direct file editing.
3. Do not commit `.zero/*`, `dist`, `node_modules`, or `test-results`.
4. Avoid destructive actions unless explicitly requested.
5. Keychain tests must never target the production master-key entry (service `com.zero-os.vault`, account `master-key`): pass an isolated `KeychainTarget` or a stub `Keychain` layer. `KeychainLive` refuses production-target set/delete while `NODE_ENV=test` (bun:test sets it), and the keychain suites verify the real entry via a digest-only canary before/after each run.
6. Never revert or overwrite user changes you did not make.
7. Keep changes scoped to the requested task only.

## Tool and Search Preferences
- Prefer dedicated tools over raw shell when available.
- Prefer `rg` for text search and `rg --files` for file discovery.
- Read enough surrounding context before editing; avoid repeated tiny blind edits.
- Batch related reads/searches when possible instead of exploring one file at a time.
- Use shell for tasks that truly require execution, repo-wide validation, or tooling not exposed elsewhere.

## Editing Constraints
- Follow existing code patterns, naming, helpers, and package boundaries before introducing new abstractions.
- Reuse existing utilities when possible; do not duplicate logic without a good reason.
- Keep public exports and cross-package contracts stable unless the task explicitly requires breaking changes.
- Preserve behavior by default; if behavior changes intentionally, make it explicit in the summary and add/update tests when appropriate.
- When code changes affect behavior, interfaces, workflows, or operational expectations, update the corresponding documentation in the same task.
- Avoid broad catch-all error handling or silent fallbacks that hide failures.
- Prefer concise, maintainable diffs over cleverness.

## Coding Conventions
- Follow existing style via Biome:
  - 2 spaces
  - single quotes
  - no semicolons
  - line width ~100
- Keep TypeScript type safety intact; avoid unnecessary casts such as `any`.
- Add comments only when they clarify non-obvious intent.

## Validation Expectations
- Validate every code change with at least one relevant command.
- For TypeScript changes, `bun run check` is the default baseline.
- Run the narrowest useful validation first, then broaden if risk is higher.
- Place new test files under a nearby `__tests__` directory instead of alongside product code. Legacy colocated tests may remain unless the task explicitly calls for migration.
- Preferred validation choices:
  - `bun run check` for TS/type-level changes
  - `bun run test` for logic changes
  - `bun run test:e2e` for UI/API/session/websocket behavior
  - targeted test commands if a smaller relevant scope exists
- If you cannot run a needed validation, say so clearly and explain why.

## Dev Commands (from repo root)
- Install deps: `bun install`
- Type check: `bun run check`
- Lint: `bun run lint`
- Unit/integration tests: `bun run test`
- E2E: `bun run test:e2e`
- Start system: `bun zero start`
- Web dev/build:
  - `bun run dev:web`
  - `bun run build:web`

## Change Workflow for Agents
1. Identify the relevant files, then read/search broadly enough to understand current behavior.
2. Implement the smallest coherent patch that solves the actual problem.
3. Update any impacted documentation alongside the code change.
4. Verify with at least one relevant command; use broader validation for higher-risk changes.
5. Summarize clearly:
   - files changed
   - why the change was made
   - verification commands and results
   - any risks, assumptions, or follow-ups

## Task-Specific Guidance
- If touching session, tool, or memory flows (`apps/server`, `packages/core`, `packages/memory`, `packages/observe`), prioritize regression safety and logging consistency.
- If touching websocket or UI routing (`apps/web`, relevant `e2e/*`), run relevant e2e coverage when feasible.
- If touching scheduler or channel integrations, preserve backward compatibility and graceful error surfacing.
- If touching secrets or operational state handling, be extra careful not to expose or mutate local runtime data unintentionally.

## Communication Style for Agents
- Be concise and concrete.
- Lead with what changed and why.
- Do not dump large file contents unless explicitly requested.
- Mention blockers early if the task cannot be completed safely.
