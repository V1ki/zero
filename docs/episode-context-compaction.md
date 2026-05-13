# Episode-Level Context Compaction

## Current Data Flow And Risks

- `Session.processMessage()` builds `conversationHistory` from persisted session messages, then `Agent.run()` prepares that history for provider replay.
- `AgentLoop` keeps the active turn in memory and appends fresh `tool_use` / `tool_result` messages before the next model call.
- `Agent.processToolResults()` already artifactizes very large tool outputs, but old `prepareConversationHistory()` also mutated historical `tool_result` blocks in place. That made replay smaller, but risked losing raw evidence from the session DB.
- Provider adapters require valid `tool_use` / `tool_result` pairing. Any compaction must either keep a valid pair or remove both sides into text summary.
- `task_closure=block` is not a finished-work signal. The latest/current turn stays high fidelity; unpaired tool-use turns are explicitly excluded from episode compaction.

## Schema

`ToolEvidence`

- Layer: message metadata, trace request entries, artifact path, UI tool detail.
- Shape: `kind`, `sessionId`, `toolUseId`, `toolName`, `path`, `chars`, `bytes`, `sha256`, optional `summary`, `strategy`, and `writeStatus`.
- Purpose: point to exact raw tool input/output without replaying it inline forever.

`EpisodeCompaction`

- Layer: prompt replay text message, backed by `ToolEvidence` artifact files.
- Shape: `boundaryStrategy`, `boundaryReason`, `goal`, `scope`, `toolUseIds`, `confirmedFacts`, `inferredFacts`, `blockers`, `needsRawReview`, `evidence`, `messageIds`, `summary`.
- Purpose: replace old paired tool-heavy turns with a semantic segment explaining why tools were called, what was inspected or changed, what was learned, what is confirmed/inferred/blocked, and where raw evidence lives.
- Boundary note: v1 uses deterministic contiguous older-turn grouping. The schema names that strategy explicitly so a future semantic classifier can replace only the boundary selection layer while preserving the same evidence pointers.

`WorkingStateCompaction`

- Layer: prompt replay text message.
- Shape: `currentGoal`, `scope`, `confirmedFacts`, `nextAction`, `blockers`, `doNot`, `evidencePointers`, `sourceEpisodeIds`.
- Purpose: keep the current task control surface small and explicit after older episodes are compacted.

## Compression Boundary

- Active/latest turn: preserved with full tool history except oversized outputs that are represented by an artifact reference plus `ToolEvidence`.
- Older paired tool turns: compacted into an episode summary in prompt replay. Raw tool inputs and outputs are written under `.artifacts/<sessionId>/tool-evidence/`.
- Medium active-turn tool outputs that exceed the per-tool prompt budget but remain below the 64KB artifact threshold keep their full content for the next model request and also write raw `ToolEvidence` first, so later replay compaction can reference the original IO instead of a truncated carrier.
- Unfinished turns: if a `tool_use` has no paired `tool_result`, its containing turn is not compacted.
- Blocked turns: assistant messages finalized with `task_closure=block` carry compact metadata with the classifier reason, so old replay can mark a blocked episode instead of flattening it into finished work.
- Provider legality: compacted old turns remove both `tool_use` and `tool_result` from replay; retained turns keep valid pairs.
- Conservative facts: `confirmed` only means the tool IO was captured or an explicit blocker is present. Assistant prose and success-result interpretation stay in `inferred` unless separately verified by evidence.

## Observability

- `tool_result` blocks can carry `evidence`.
- request trace `toolCalls` / `toolResults` preserve evidence pointers.
- When episode compaction happens, Agent emits a `context_compaction` trace span named `episode_compaction` plus a `context_compaction.episode` run.log entry. The payload includes before/after message counts, prompt chars/tokens, compacted/retained message ids, episode count, boundary strategy, skipped unfinished tool ids, and evidence totals.
- Each active-turn tool input/output evidence write and each episode-compaction evidence pointer is logged as `tool_evidence.persisted` with source, reason, tool id, evidence path, chars, bytes, hash, and write status.
- Session detail tool cards render evidence path, chars, and hash when available.

## Known Risks And Extensions

- Episode grouping is deterministic and turn-based today; future work can use task-closure trace events or an LLM classifier to merge adjacent turns around the same subproblem more precisely.
- Existing sessions without `ToolEvidence` will gain evidence files when their old tool turns are compacted for replay.
- Raw artifacts may contain sensitive local data. `.artifacts/` is runtime-only and gitignored; do not move evidence files into tracked source paths.
