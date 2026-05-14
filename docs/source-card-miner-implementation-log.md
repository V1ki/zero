# Source Card Miner Implementation Log

## Current MVP

Session Source Miner generates Source Card drafts from existing session evidence only.

Inputs:

- session row
- persisted messages
- trace entries
- run log entries
- referenced artifacts that already exist locally

Outputs:

- `SourceCardDraft`
- `proposedCard` with state `draft`
- evidence refs
- missing fields
- risk flags
- dedupe candidates
- trigger snapshot

The proposed card is a Markdown document card. The miner no longer emits adapter schemas, credential bindings, health checks, watch capabilities, or observation contracts.

## Create Flow

`createFromDraft()` persists the proposed card only when `confirm=true`.

If the server recomputes likely duplicates, the caller must provide a `dedupeDecision`.

Current dedupe decisions:

- `new_card`: create the draft as a separate Source Card.
- `append_evidence`: intentionally not implemented in this MVP.

## Tool/API Surface

Tool actions:

- `generate_draft`
- `validate_draft`
- `create_from_draft`

API routes:

- `POST /api/source-card-drafts`
- `POST /api/source-card-drafts/validate`
- `POST /api/source-card-drafts/cards`

## Safety

Drafts are strictly redacted:

- no credential refs
- no secret values
- no bearer tokens
- no cookie/password/token strings
- private mailbox evidence is summarized as metadata only

The miner does not execute new source access. It only condenses what the session already persisted.
