# Source Card UI/UX

## Product Shape

Source Cards are small Markdown source guides. They should feel closer to a local skill note than a database integration console.

The UI should optimize for three questions:

- What source does this document describe?
- Is it a draft, active, or retired?
- What exact Markdown guidance should the agent read before using ordinary tools?

## List View

The list starts empty. It must not imply built-in QQ Mail, A-share, or any other sample card.

Columns:

- Source: title, id, short source summary.
- State: `draft`, `active`, or `retired`.
- Sensitivity: `public`, `internal`, `private`, or `restricted`.
- Tags.
- Updated time.

Filters:

- state
- sensitivity
- search across id, title, tags, summary, and Markdown body

## Detail View

Primary content is the `sourceDoc` Markdown body. It should be easy to scan and copy from visually, but the UI does not execute anything in it.

Secondary panels:

- source evidence: session id, trace refs, artifact refs, short summary
- metadata: state, sensitivity, tags, created/updated timestamps
- review actions: activate a draft, retire a non-retired card

## Actions

Activation requires a human-readable reason. It only changes state from `draft` to `active`.

Retirement requires a human-readable reason. It only changes state to `retired`.

The UI does not provide:

- health probes
- source execution
- credential binding
- watch creation
- observation browsing
- adapter revision editing

## Copy Rules

Use "Source Doc" for the Markdown body.

Use "Activate" instead of "Promote".

Use "Draft review" for inactive drafts.

Do not describe Source Cards as automatic connectors. They are durable guidance documents.
