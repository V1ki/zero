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
- Shape: `kind`, `sessionId`, `toolUseId`, `toolName`, `path`, `chars`, `bytes`, `sha256`, optional `summary` and `strategy`.
- Purpose: point to exact raw tool input/output without replaying it inline forever.

`EpisodeCompaction`

- Layer: prompt replay text message, backed by `ToolEvidence` artifact files.
- Shape: `goal`, `scope`, `toolUseIds`, `confirmedFacts`, `inferredFacts`, `blockers`, `needsRawReview`, `evidence`, `messageIds`, `summary`.
- Purpose: replace old paired tool-heavy turns with a semantic segment explaining why tools were called, what was inspected or changed, what was learned, what is confirmed/inferred/blocked, and where raw evidence lives.

`WorkingStateCompaction`

- Layer: prompt replay text message.
- Shape: `currentGoal`, `scope`, `confirmedFacts`, `nextAction`, `blockers`, `doNot`, `evidencePointers`, `sourceEpisodeIds`.
- Purpose: keep the current task control surface small and explicit after older episodes are compacted.

## Compression Boundary

- Active/latest turn: preserved with full tool history except oversized outputs that are represented by an artifact reference plus `ToolEvidence`.
- Older paired tool turns: compacted into an episode summary in prompt replay. Raw tool inputs and outputs are written under `.artifacts/<sessionId>/tool-evidence/`.
- Unfinished turns: if a `tool_use` has no paired `tool_result`, its containing turn is not compacted.
- Provider legality: compacted old turns remove both `tool_use` and `tool_result` from replay; retained turns keep valid pairs.

## Observability

- `tool_result` blocks can carry `evidence`.
- request trace `toolCalls` / `toolResults` preserve evidence pointers.
- Session detail tool cards render evidence path, chars, and hash when available.

## Known Risks And Extensions

- Episode grouping is deterministic and turn-based today; future work can use task-closure trace events or an LLM classifier to merge adjacent turns around the same subproblem more precisely.
- Existing sessions without `ToolEvidence` will gain evidence files when their old tool turns are compacted for replay.
- Raw artifacts may contain sensitive local data; they are stored under runtime workspace artifacts and should not be committed.
