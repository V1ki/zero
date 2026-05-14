# Source Card Goal Context

## Current Decision

Source Card is no longer a complex schema for adapters, watches, credentials, health checks, or observations.

It is a small durable Markdown document that can be discovered from prior session evidence, reviewed, activated, and used as preflight guidance in later requests.

## Data Model

Required fields:

- `schemaVersion: 1`
- `id`
- `title`
- `state`: `draft`, `active`, or `retired`
- `sensitivity`: `public`, `internal`, `private`, or `restricted`
- `sourceDoc.format: markdown`
- `sourceDoc.body`

Optional fields:

- `tags`
- `source.sessionId`
- `source.traceRefs`
- `source.artifactRefs`
- `source.summary`
- `createdAt`
- `updatedAt`

## Agent Policy

When a user asks for a known reusable external data source, the agent should:

1. Call `source_card list`.
2. If a likely match exists, call `source_card get`.
3. Read `sourceDoc` before choosing URLs, commands, fields, fallbacks, and safety boundaries.
4. Use ordinary foreground tools only when the card state and document allow it.
5. Never treat Source Card as an executor.

Private, restricted, and draft cards are blockers unless the user explicitly approves the required foreground action.

## Mining

Session Source Miner can generate a draft from existing persisted evidence.

It must not:

- query new external sources
- read fresh mailbox content
- fetch market data
- run health checks
- store secrets
- auto-activate cards

Draft creation requires explicit confirmation.
