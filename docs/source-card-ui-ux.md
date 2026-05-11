# Source Card UI/UX Design

## One-line Responsibility

Source Card UI 是 Zero 中让用户查看、验证、提升、停用和审计“稳定获取某类数据的能力”的操作台，而不是 Watch、cron、一次性工具调用记录或数据内容浏览器。

## Design Thesis

### visual thesis

克制的运维控制台：深色、低噪声、高密度，以表格、分栏、状态条和审计时间线承载决策，使用现有 cyan accent 只强调当前选择和主操作。

### content plan

- primary workspace：`Source Cards` 列表，首屏展示状态、adapter、health、sensitivity、Watch 可用性和更新时间。
- support：顶部筛选、状态计数、风险提示和搜索，用于快速定位 candidate、degraded、broken、private source。
- detail：选中或进入详情后，以左侧主内容 + 右侧 inspector 展示 identity、capabilities、adapter revision、credential summary、privacy、health、observations 和 evidence。
- final action：promotion/retire drawer 用检查清单和确认文案完成用户审批，不做营销式 CTA。

### interaction thesis

- 列表行到详情页使用稳定的选中态和同构信息结构，用户从列表扫风险，进入详情做审批。
- promotion/retire 使用右侧 drawer 或 modal，让用户在不丢失上下文的情况下核对 scope、health、credential binding 和 Watch 影响。
- health、observation、audit evidence 用折叠行和时间线渐进披露，只展示脱敏摘要，不把 UI 变成原始日志浏览器。

## Information Architecture

### Navigation

- 在现有 `apps/web` 左侧导航中新增 `Sources` 或 `Source Cards`，位置建议放在 `Tools` 之后、`Logs` 之前。
- 移动端底部 tab 空间有限，首版不强制加入底部主 tab；可以通过 `Tools` 或桌面侧边栏进入。若必须加入移动端，优先命名为 `Sources`，图标使用与数据源/连接相关的 Phosphor icon。

### Routes

- `/source-cards`：Source Cards 列表工作台。
- `/source-cards/$id`：Source Card 详情页。
- `/source-cards/$id?panel=promote`：打开 promotion drawer。
- `/source-cards/$id?panel=retire`：打开 retire confirmation。

### Main Objects

- Source Card：低频能力契约，包含 lifecycle、adapter、credential binding、privacy、health contract、capabilities、promotion evidence。
- Watch binding preview：只展示 `sourceCardId + capabilityId + query/cursor + cadence + allowedActions`，不展示凭证。
- Observation summary：高频观测摘要，只展示 freshness、counts、hash/schema、failure class、cursor 摘要和 artifact refs。
- Trace/audit evidence：脱敏审计证据，只展示状态码、exit code、duration、schema keys、row count、hash、artifact refs 和 failure class。

## Page List

1. Source Cards List
2. Source Card Detail
3. Promotion Review Drawer
4. Retire Confirmation
5. Private Source Scope Review
6. Public Source Watch-ready Review
7. Health and Observation Panel
8. Empty, Error, and Security States

## Source Cards List

### Layout

Use a dense table-like workspace inside the existing page shell:

- Page title: `Source Cards`
- One-line scope text: `Persistent data-source capabilities. Watches can only reference active watchable capabilities.`
- Toolbar:
  - search by id/title/kind
  - state segmented filter: `All`, `Candidate`, `Verified`, `Active`, `Degraded`, `Broken`, `Retired`
  - adapter filter: `All`, `CLI`, `API`, `Browser`, `Direct`
  - sensitivity filter: `All`, `Public`, `Internal`, `Private`, `Restricted`
- Status strip:
  - `Active watch-ready`
  - `Need review`
  - `Degraded`
  - `Broken`
  - `Private scope blocked`
- Table columns:
  - `Source`
  - `State`
  - `Kind`
  - `Sensitivity`
  - `Adapter`
  - `Health`
  - `Watch`
  - `Updated`

### Row Content

- Source cell:
  - title
  - monospace id
  - short learned method summary
- State:
  - text label plus semantic dot, never color-only
- Adapter:
  - mode and active revision id
  - `cli`, `api`, `browser`, `direct`
- Health:
  - `healthy`, `degraded`, `broken`, or `unknown`
  - failure class if present
- Watch:
  - `Allowed`
  - `Needs promotion`
  - `Blocked by privacy`
  - `No watchable capability`
  - `Retired`
- Updated:
  - relative time using existing `formatTimeAgo`

### Actions

- Primary row action: `Open`
- Context actions:
  - `Validate` for candidate/verified/degraded/broken
  - `Promote` only when Source Card is `verified` or recoverable `degraded`
  - `Retire`

### Visual Rules

- Prefer a flat list/table with row dividers over a grid of cards.
- Use existing dark surface tokens and `--color-accent` only for selected filter/current row.
- Semantic status colors may use existing success/warning/error/idle, but labels must remain readable without color.
- Avoid large KPI cards; the status strip should be compact, one line on desktop and horizontally scrollable on mobile.

## Source Card Detail

### Layout

Desktop:

- Header band:
  - title and id
  - lifecycle state
  - sensitivity
  - adapter mode
  - health status
  - primary action button
- Main grid:
  - left column, about 65 percent: identity, capabilities, adapter revision, privacy, health, observation summary, trace/audit evidence
  - right sticky inspector, about 35 percent: promotion readiness, credential binding summary, Watch eligibility, lifecycle actions

Mobile:

- Header stays compact.
- Content becomes tabs or stacked sections:
  - `Overview`
  - `Capabilities`
  - `Health`
  - `Audit`
- Inspector actions become a bottom action bar or top section.

### Sections

#### Source Identity

Shows:

- `id`
- `title`
- `kind`
- `owner scope`
- `sensitivity`
- `firstSeenAt`
- `discoveredFrom.sessionId`
- trace/artifact refs as copyable references
- learned method summary

Do not show:

- raw trace log text
- command output containing private data
- any credential ref value

#### Lifecycle

Shows the state path:

`discovered -> candidate -> verified -> active -> degraded/broken -> retired`

Current state is highlighted. Past accepted transitions show timestamp and decision reason where available. Disallowed next steps are visible but disabled with reason.

#### Capabilities

Table columns:

- `Capability`
- `Operation`
- `Watchable`
- `Default privacy scope`
- `Allowed actions`
- `Prohibited actions`
- `Input schema`
- `Output schema`

Interaction:

- schema preview is collapsed by default and shows keys, not raw samples.
- watchable capabilities show `Watch-ready only when card is active`.
- prohibited actions are always visible for private mail and market data.

#### Adapter Revision

Shows:

- mode
- active revision
- revision status: candidate/active/deprecated/rolled_back
- entrypoint
- parser type and schema keys
- timeout and rate limit
- validation sample names or redacted query descriptions

Sensitive handling:

- CLI command templates are shown as redacted templates or command hashes when they could reveal local private paths.
- API endpoint templates show host/path pattern and hash for sensitive query templates.
- Browser adapter shows profile/session binding status only, not cookies.

#### Credential Binding Summary

Shows only public view fields from `SourceCardService`:

- credential id
- required
- binding type: `vaultRef`, `externalStore`, `none`
- `hasReference`
- inject mode
- scopes
- lease ttl and renewable if exposed later

Never show:

- `binding.ref`
- secret values
- token/cookie/password/authorization material
- `.zero/secrets.enc` paths

Recommended labels:

- `Configured through external profile`
- `Vault reference configured`
- `No credential required`
- `Credential missing`
- `Reauthorization required`

#### Privacy Policy

Matrix:

| Data area | Policy | Background allowed | UI copy |
| --- | --- | --- | --- |
| Metadata | allowed by capability scope | yes when active/watchable | `Envelope or quote metadata only` |
| Body/content | metadata_only / explicit_foreground_only / approved_background_scope | usually no | `Requires explicit foreground approval` |
| Attachments/files | blocked / explicit_foreground_only / approved_background_scope | usually no | `Blocked for background watch` |
| Artifacts | retention policy | only references | `Artifact refs only in audit` |

For private/restricted cards, the privacy matrix sits above observations so users see boundaries before evidence.

#### Health Checks

List each configured check:

- check id
- cadence
- method
- success criteria
- last result
- checked at
- failure class
- redacted evidence

Evidence display:

- status code
- exit code
- duration
- row count
- schema keys
- command/endpoint template hash
- artifact refs
- short sanitized message

Do not show raw stderr/stdout if it could include private content or secrets.

#### Observation Summary

Observation is not card mutation and not a log browser. Show:

- last observed at
- observation kind counts: data, health_check, schema_sample, error
- latest cursor summary
- content hash policy
- max sample persisted
- freshness status
- last failure class
- schema keys and row count

Do not show:

- full email body
- raw attachments
- personal financial details
- full raw market response dumps

#### Trace/Audit Evidence

Timeline entries:

- created candidate
- validation passed/failed
- promoted/retired
- health result recorded
- adapter revision changed
- observation contract changed

Each entry includes actor/source, timestamp, reason, sanitized evidence, and linked trace/artifact refs.

## State Model

| State | Meaning | UI treatment | Allowed primary action | Watch eligibility |
| --- | --- | --- | --- | --- |
| discovered | observed in session/trace but not normalized | muted dot, `Needs candidate` | create candidate card | no |
| candidate | normalized but not verified | warning dot, `Needs validation` | validate | no |
| verified | validation passed with evidence | blue/cyan dot, `Ready for approval` | promote | no until active |
| active | approved reusable source | success dot, `Watch-ready if capability allows` | view/retire | yes for watchable capabilities |
| degraded | usable with partial or recent failure | warning dot, failure class visible | review/promote after pass/retire | conditional; block new watches by default |
| broken | cannot be safely used | error dot, next step visible | revalidate or retire | no |
| retired | intentionally disabled | idle dot, read-only | view audit only | no |

### Failure Classes

Display failure classes as short labels with next-step copy:

- `auth`: reauthorize or fix credential binding.
- `schema`: adapter parser or output schema drift; candidate revision required.
- `rate_limit`: reduce cadence or wait for reset.
- `network`: retry later or check connectivity.
- `stale`: source reachable but data freshness failed.
- `privacy_blocked`: requested operation violates privacy policy.
- `adapter_unavailable`: CLI/browser/protocol dependency missing.
- `unknown`: inspect sanitized evidence and trace refs.

## Promotion Flow

### Entry Conditions

- Source Card state is `verified` or `degraded`.
- At least one health check has passed or an approved manual evidence item exists.
- Credential binding is configured if required.
- Privacy policy supports every watchable capability being promoted.
- No unresolved `privacy_blocked`, `auth`, or `adapter_unavailable` failure.

### Drawer Layout

Header:

- `Promote Source Card`
- id/title/state
- one-line impact summary

Checklist:

- Source Card schema is valid.
- Active adapter revision is selected.
- Required health checks passed.
- Credential binding is configured without exposing references.
- Privacy policy reviewed.
- Watch-compatible capabilities reviewed.
- Prohibited actions reviewed.
- Promotion reason entered.

Private source extra checklist:

- metadata-only background scope confirmed.
- body/content access not approved for background.
- attachments blocked or foreground-only.
- no raw private content will be written to observations/trace.

Footer:

- `Promote to active`
- `Cancel`

All checklist failures show an exact blocker and link to the detail section.

## Retire Flow

Retire is a confirmation dialog for low-complexity cases and a drawer if active watches exist.

Shows:

- Source Card id/title.
- Current state.
- Watches that reference this card, if API later exposes them.
- Expected impact: new watch ticks are blocked; existing Source Card remains in audit.
- Required reason.

Button:

- `Retire Source Card`

Retired cards remain visible by default only when `Retired` filter is selected.

## Private Source Flow: qq-mail-himalaya

### List Row

- Source: `QQ Mail via Himalaya`
- id: `qq-mail-himalaya`
- kind: `private_mailbox`
- sensitivity: `private`
- adapter: `cli / active revision`
- health: last CLI/account/folder/envelope result
- Watch: `Blocked until active metadata-only approval`

### Detail Emphasis

Identity:

- discovered from QQ mail session trace refs.
- method summary: `himalaya CLI can list account folders and envelope metadata.`

Credential summary:

- binding type: `externalStore`
- label: `Configured through external CLI profile`
- inject mode: `profileSession`
- scopes: `mail.metadata.read`
- `hasReference: true`

The UI must not render the literal external credential ref value.

Privacy matrix:

- Envelope metadata: allowed for approved watch.
- Body: foreground explicit only or blocked unless future scope is approved.
- Attachments: blocked for background watch.
- Sending mail: not a capability; prohibited.

Health checks:

- `cli_available`: himalaya executable/version check.
- `account_available`: account alias exists.
- `folder_list`: folders are listable.
- `envelope_list`: envelope metadata returns parseable schema.

Auth failure:

- show `auth` failure class.
- state should move or remain `broken`.
- action: `Reauthorize external CLI profile`.
- no stderr/raw output shown unless sanitized.

Evidence:

- command template hash
- exit code
- duration
- schema keys such as envelope id/date/from/subject presence, not subject values in trace UI by default
- artifact refs when applicable

Background Watch Decision:

- allowed only when card is `active`, capability is watchable, and requested Watch binding uses metadata-only scope.
- Watch may reference `sourceCardId: qq-mail-himalaya` and a capability like `list_envelopes`.
- Watch cannot store credential refs or request body/attachment persistence.

## Public Source Flow: a-stock-market-data

### List Row

- Source: `A-stock Market Data`
- id: `a-stock-market-data`
- kind: `public_market_data`
- sensitivity: `public`
- adapter: `api / active revision`
- health: endpoint/schema/freshness summary
- Watch: `Allowed` when active and healthy

### Detail Emphasis

Credential summary:

- binding type: `none`
- label: `No credential required`
- inject mode: `none`
- scopes: empty or `public.market.read`

Privacy:

- public/read-only.
- observations may record quote snapshots or ranking summaries according to observation contract.
- no personal brokerage/account data.

Prohibited actions:

- broker login
- order placement
- trade execution
- auto-rebalancing
- account-position reads

Health checks:

- canonical endpoint returns success.
- JSON/CSV schema keys match expected parser.
- row count is within reasonable range.
- freshness matches market calendar expectation.
- rate limit/403/5xx/schema drift map to failure classes.

Auth failure:

- should not occur for `none` credential binding.
- if endpoint starts requiring auth, show `schema` or `auth` depending on response and require candidate adapter revision instead of silently adding credentials.

Evidence:

- endpoint template hash
- status code
- duration
- row count
- schema keys
- freshness timestamp

Background Watch Decision:

- allowed when card is `active`, health is not `broken`, and capability is watchable.
- Watch can request symbols/query/cursor/cadence and allowed actions `notify` or `recordObservation`.
- Watch UI must state `read-only market data; no trading actions are available`.

## Health Runner and Observation Display

### Health Runner Banner

Until real probes are implemented, detail pages should show:

`Health runner records validated results. It does not execute CLI/API/browser/direct probes from this UI yet.`

This prevents users from expecting the UI to run `himalaya` or fetch market data.

### Health Result Rows

Each row shows:

- check id
- status
- checked at
- failure class
- evidence chips
- source trace/artifact ref

Evidence chips are small text tokens, for example:

- `exit 0`
- `HTTP 200`
- `248ms`
- `schema: symbol, price, updatedAt`
- `rows: 320`
- `endpoint hash: ...`

### Observation Summary Rows

Rows show:

- capability
- observation kind
- last observed
- cursor summary
- count
- freshness
- hash/schema summary
- latest failure class

The UI intentionally does not provide a raw JSON viewer for private observations. Public observations can expose compact samples only if the observation contract allows it.

## Empty, Error, and Security States

### No Source Cards

Text:

`No Source Cards yet. Data sources become candidates after an Agent discovers a reusable, safe retrieval method.`

Action:

- no create form in the first version unless backed by validated candidate generation.

### Candidate But Unverified

Text:

`This source is normalized but not verified. Watches cannot use it yet.`

Action:

- `Validate`
- show required evidence list.

### Credential Missing

Text:

`A required credential binding is not configured. The UI can show binding type and scope, but not the credential reference or value.`

Action:

- `Open credential setup` only if a safe settings route exists later.
- otherwise show operational instruction without secret values.

### Auth Expired

Text:

`The source failed authentication. Reauthorize the external profile or refresh the Vault-backed credential.`

Action:

- revalidate after reauth.

### Adapter Unavailable

Text:

`The adapter dependency is unavailable on this runtime.`

Examples:

- CLI missing.
- browser profile unavailable.
- direct protocol client not installed.

### Private Scope Blocked

Text:

`The requested capability would read content outside the approved privacy scope.`

Action:

- show the allowed metadata scope.
- do not offer a one-click override in the Source Card UI.

### Schema Drift

Text:

`The source responded, but the parser did not find the expected schema. Create a candidate adapter revision before promotion.`

### Health Runner Not Connected To Real Probe

Text:

`Health results are recorded from validated runner inputs. Real source probes are not executed from this UI in the current implementation.`

## API Surface Draft

Do not implement in this design step. Suggested endpoints should reuse `SourceCardService` public views and never return credential refs.

```http
GET /api/source-cards
GET /api/source-cards/:id
POST /api/source-cards/:id/validate
POST /api/source-cards/:id/promote
POST /api/source-cards/:id/retire
GET /api/source-cards/:id/observations?summary=1
GET /api/source-cards/:id/audit
POST /api/source-cards/:id/health-results
```

Response rules:

- list/get return `SourceCardPublicView`, not raw `SourceCard`.
- credential output is limited to `credentialBindings`.
- observation endpoints default to summaries.
- audit evidence is sanitized by the same Source Card evidence sanitizer used by core.
- mutation endpoints require `reason`.
- promotion payload includes reviewed capability ids and explicit private-scope confirmation when sensitivity is private/restricted.

Draft promote payload:

```json
{
  "reason": "Health checks passed and metadata-only scope approved.",
  "reviewedCapabilityIds": ["list_envelopes"],
  "privateScopeConfirmation": {
    "metadataOnly": true,
    "bodyAccessApproved": false,
    "attachmentAccessApproved": false
  }
}
```

## Component List

- `SourceCardsPage`
- `SourceCardTable`
- `SourceCardTableToolbar`
- `SourceStateBadge`
- `SourceHealthBadge`
- `WatchEligibilityBadge`
- `SourceAdapterBadge`
- `SourceCardDetailPage`
- `SourceIdentitySection`
- `LifecycleRail`
- `CapabilityTable`
- `AdapterRevisionSection`
- `CredentialBindingSummary`
- `PrivacyPolicyMatrix`
- `HealthCheckList`
- `HealthEvidenceChips`
- `ObservationSummaryTable`
- `PromotionEvidenceChecklist`
- `TraceAuditTimeline`
- `PromoteSourceDrawer`
- `RetireSourceDialog`
- `PrivateScopeReview`
- `PublicWatchReadyPanel`
- `SourceSecurityBanner`
- `FailureClassBadge`
- `EmptySourceCardsState`

## Accessibility and Responsive Requirements

- All status indicators include text labels; color is never the only signal.
- Table rows are keyboard focusable and open with Enter.
- Filters are real buttons/selects with visible focus styles.
- Drawers/dialogs trap focus and restore focus to the invoking button.
- Promotion and retire actions require explicit button activation, not row click side effects.
- Evidence chips use readable text and tooltips for abbreviations.
- On mobile, tables become horizontally scrollable or convert to list rows with the same field labels.
- Right inspector becomes stacked content or a bottom action panel.
- Minimum tap target should stay at least 40px for destructive or promotion actions.
- No hover-only critical information.

## apps/web Integration Advice

- Add routes in `apps/web/src/app/router.tsx`: `/source-cards` and `/source-cards/$id`.
- Add a sidebar item in `apps/web/src/app/components/layout/Sidebar.tsx`; mobile `TabBar` can wait unless product wants Sources as a primary mobile task.
- Follow existing page shell: `p-6 max-w-[1400px] mx-auto`, compact heading, existing `input-field`, `Skeleton`, `ConfirmDialog`, and toast patterns.
- Prefer a table/list layout over `card` grids. Where existing `.card` is reused, use it only for toolbar, modal/drawer, or true bounded inspector regions.
- Add API helpers through existing `apiFetch`/`apiPost` patterns.
- Add Hono endpoints in `apps/web/src/api/routes.ts` only after backend service wiring is reviewed.
- API endpoints should call `SourceCardService`, not the Agent `source_card` tool.
- Keep `source_card` tool as a management tool for Agent workflows; the UI should not depend on a model/tool call path.
- Use shared types from `@zero-os/shared` and public view types from core/server boundary once exported through an API-safe layer.

## Security and Privacy UX Rules

- Never render real secret values, authorization codes, cookies, tokens, passwords, or full credential refs.
- Never expose `.zero/secrets.enc`.
- Never display private email bodies or attachments in Source Card UI.
- Private source default is metadata-only.
- Any larger private scope requires explicit foreground approval outside the default promotion flow.
- Watch preview must prove it only references `sourceCardId + capabilityId + query/cursor + cadence + allowedActions`.
- UI never stores credentials in local state beyond public summary fields returned by API.
- Trace evidence is shown only after sanitization.
- Observation display is summary-first and contract-bound.
- Source Card UI must not offer automatic trading, order placement, broker login, email sending, or remote write operations.

## What This Design Does Not Do

- No frontend implementation.
- No API implementation.
- No database migration.
- No scheduler or cron redesign.
- No direct execution of CLI/API/browser/direct adapters from UI.
- No real private mail reading.
- No raw observation log browser.
- No credential editing workflow.
- No automatic trading, auto-ordering, auto-emailing, or remote write action.
- No Watch creation wizard beyond showing whether a Source Card capability is watch-compatible.

## Next Implementation Split

1. Read-only UI:
   - API list/get using public Source Card view.
   - `/source-cards` table and `/source-cards/$id` detail route.
   - credential summary redaction tests.
2. Review actions:
   - validate/promote/retire endpoints.
   - promotion drawer and retire dialog.
   - private scope confirmation payload.
3. Evidence views:
   - observation summary endpoint.
   - health result list.
   - audit timeline.
4. Watch compatibility:
   - show watch eligibility per capability.
   - optional read-only Watch binding preview.
   - ensure Watch never receives credentials from UI/API.
