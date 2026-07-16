# Compaction Harness

`@zero-os/compaction` is an independent, tool-free compaction run loop for reducing a frozen
session trace into a bounded diagnostic checkpoint and a complete change-point ledger.

## Scope

The current candidate kind is `trace_diagnostic_checkpoint`. It summarizes trace facts such as
activity groups, error incidents, entity-local state transitions, and classified potential side
effects. It does not replace canonical session messages and does not claim semantic recall of the
current goal, constraints, decisions, open work, or evidence handles.

## Run loop

1. Freeze the last complete JSONL prefix and hash the exact bytes.
2. Keep the terminal lifecycle snapshot for each span and project raw payloads to typed fields,
   counts, and digests.
3. Reduce bounded leaves, then merge them with fixed fan-in and depth limits.
4. Keep the full interval and potential-side-effect ledger while selecting a bounded inline
   candidate.
5. Validate source coverage, entity isolation, references, privacy fields, candidate/ledger byte
   budgets, and deterministic digests.
6. In `publish` mode, require a canonical session binding and delegate one atomic compare-and-swap
   to the caller-provided publisher. The harness itself does not write session state.

Unknown tools and unknown tool actions are treated as potentially mutating. Unknown span, tool,
action, kind, status, and span-id labels are represented by stable hashes instead of raw text.

## Evaluation

Run a read-only replay against a persisted session:

```bash
bun run compaction:harness-eval --session <session-id> --repeat 2
```

The report measures both checkpoint-only size and the complete candidate-plus-ledger payload. A
future semantic compaction worker should consume a frozen canonical message prefix, existing
checkpoints, and the uncompacted tail, then evaluate goal/constraint/decision/evidence-handle
recall separately.
