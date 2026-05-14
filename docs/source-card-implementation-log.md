# Source Card Implementation Log

## 2026-05-13: reset to document cards

Source Card was reset from a structured data-source schema to a small Markdown document model.

Current shape:

- Runtime starts with no built-in cards.
- No sample Source Cards are created by server startup.
- A Source Card is a JSON wrapper around `sourceDoc.format = markdown` and `sourceDoc.body`.
- Lifecycle is only `draft -> active -> retired`.
- `source_card` is a management/preflight tool, not a data-source executor.
- Session Source Miner only reads existing persisted session evidence and creates drafts.
- No Source Card health runner, observation store, adapter revision registry, watch binding resolver, or credential lease model remains in the Source Card layer.

Implemented surface:

- Shared type validation in `packages/shared/src/types/source-card.ts`.
- File-backed card storage in `packages/core/src/source-card/store.ts`.
- Service methods: `list`, `get`, `validate`, `validateDraft`, `validateStored`, `createFromDraft`, `activate`, `retire`.
- Tool actions: `list`, `get`, `validate`, `generate_draft`, `validate_draft`, `create_from_draft`, `activate`, `retire`.
- Web API routes:
  - `GET /api/source-cards`
  - `GET /api/source-cards/:id`
  - `POST /api/source-cards/:id/activate`
  - `POST /api/source-cards/:id/retire`
  - `POST /api/source-card-drafts`
  - `POST /api/source-card-drafts/validate`
  - `POST /api/source-card-drafts/cards`
- Web UI now renders Source Cards as Markdown source guides with simple activation and retirement actions.

Safety boundary:

- Source Cards must not contain secret values or credential references.
- Private and restricted cards remain foreground-review documents.
- The agent must read `sourceDoc` before using ordinary tools such as fetch, bash, or browser.
- The card may describe safe retrieval methods, but it does not run them.

Operational reset:

- Existing runtime card files under `.zero/source-cards/cards` were removed for this reset.
- `.zero/source-cards` remains local operational state and is not product source.
