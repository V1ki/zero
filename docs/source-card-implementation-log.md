# Source Card Implementation Log

## 本次目标

直接实现 Zero 的 Source Card 数据源卡最小完整闭环，让 Zero 能表达、保存、验证和审计一个数据源能力，并为后续 Watch 通过 Source Card 消费数据源打好运行时边界。

## 已读取的关键上下文

- `AGENTS.md`
- `docs/source-card-goal-context.md`
- Codex session `019e14f5-376a-73b3-84b4-da9cbeeaf58e`
- `sess_20260508_2153_fei_9b99` 的 trace/run.log 摘要：QQ 邮箱通过 `himalaya` CLI 发现和读取数据源能力，另有临时 schedule 创建后取消。
- `sess_20260508_0926_fei_9398` 的 trace/run.log 摘要：股票数据通过公共 HTTP/API、脚本和产物逐步形成可复用来源。
- 当前 `schedule` tool、scheduler 触发路径、Vault/secretResolver、trace、memory、tool registry 实现边界。

## 实际修改的文件

- `packages/shared/src/types/source-card.ts`
  - 新增 Source Card、Source Observation、Source Watch Binding、credential lease、health result 等核心类型。
  - 新增运行时校验与 trace evidence 脱敏工具。
- `packages/shared/src/types/index.ts`
  - 导出 Source Card 类型面。
- `packages/shared/src/__tests__/source-card.test.ts`
  - 覆盖 schema 校验、credential binding 校验、Watch 不可携带凭证、trace evidence 脱敏。
- `packages/core/src/source-card/store.ts`
  - 新增文件型 Source Card store/manager。
  - 支持 create/get/list/update/state transition、health result、observation、Watch resolve、credential lease。
- `packages/core/src/source-card/samples.ts`
  - 新增 `qq-mail-himalaya` 与 `a-stock-market-data` 两个样例卡。
- `packages/core/src/source-card/index.ts`
  - 导出 Source Card manager/store 与样例构造器。
- `packages/core/src/source-card/__tests__/manager.test.ts`
  - 覆盖持久化、health/observation、Watch 凭证边界、credential lease 引用边界。
- `packages/core/src/index.ts`
  - 导出 core Source Card 能力。
- `apps/server/src/main.ts`
  - 在 ZeroOS 启动时创建 `SourceCardManager`，挂到 `ZeroOS.sourceCardManager`，并确保两个内置样例卡存在。
- `docs/source-card-implementation-log.md`
  - 记录本次实现过程。

## 关键设计决策

- Source Card 与 `ScheduleConfig` 分离；Source Card 描述数据源能力，schedule 只描述时间触发。
- Source Card lifecycle 使用显式状态转移表约束：`discovered -> candidate -> verified -> active`，并允许 active 后进入 `degraded`、`broken`、`retired`。
- Watch 只允许引用 `sourceCardId + capabilityId + query/cursor + cadence`，不能携带凭证字段。
- Source Card 的低频能力定义与 Observation 的高频运行数据分离。
- Source Card 凭证只保存引用：`vaultRef`、`externalStore`、`none`。
- 私人数据源默认 metadata-only；正文、附件或更大权限必须通过 capability scope 显式表达。
- Trace/audit 证据进入存储前默认脱敏。

## 为什么这样实现

- `shared` 放契约类型和运行时校验：Watch、scheduler、tool、server 未来都可以共享同一套边界，避免每个模块各自理解 Source Card。
- `core` 放 manager/store：当前项目已有大量运行时能力在 core 层组织，Source Card 需要靠近 session/tool/runtime，但不应该塞进 scheduler 或 schedule tool。
- 采用文件型存储：符合当前 `.zero` 本地运行时状态风格，避免为最小闭环引入迁移或数据库 schema 变更。
- `SourceCardManager.resolveWatch()` 返回 capability、adapter 和 binding 的运行时视图，不返回 `credentials` 字段，用类型和实现共同保证 Watch 不拥有凭证。
- `recordObservation()` 只写 Observation 文件，不更新 Source Card；`recordHealthResult()` 才允许低频更新 health/state 字段。
- credential lease 只暴露 `credentialRef`、scope、inject policy、过期时间，不返回 secret value。`vaultRef` 只通过 `secretResolver` 做可用性检查。
- trace/audit 统一走 `sanitizeSourceCardTraceEvidence()`，保留 `credentialRef` 这种引用，脱敏 token、cookie、password、authorization 等真实授权材料。

## 安全边界

- 不读取新的私人邮件正文。
- 不输出、读取、写入或提交真实密钥、授权码、cookie、token、邮箱密码。
- 不直接编辑 `.zero/secrets.enc`。
- 不实现自动交易、自动下单、自动发送邮件或远端写操作。
- `qq-mail-himalaya` 样例只使用 `external:himalaya/account/qq` 形式的凭证引用。
- `a-stock-market-data` 样例保持 read-only，禁止任何交易语义。

## 验证命令和结果

- `bun test packages/shared/src/__tests__/source-card.test.ts`
  - 结果：6 pass，0 fail。
  - 覆盖：Source Card lifecycle、schema、credential ref 前缀、Watch 禁止凭证字段、trace evidence 脱敏。
- `bun test packages/core/src/source-card/__tests__/manager.test.ts`
  - 结果：7 pass，0 fail。
  - 覆盖：样例卡持久化、lifecycle transition、Observation 不修改 Source Card、health failure 降级与脱敏、Watch resolve 不暴露凭证、candidate 私有邮箱不可直接 watch、credential lease 只暴露引用。
- `bun run check`
  - 结果：通过。
- `bunx biome check packages/shared/src/types/source-card.ts packages/shared/src/__tests__/source-card.test.ts packages/core/src/source-card/store.ts packages/core/src/source-card/samples.ts packages/core/src/source-card/index.ts packages/core/src/source-card/__tests__/manager.test.ts packages/core/src/index.ts apps/server/src/main.ts`
  - 结果：通过。

## 未解决风险或后续建议

- 第一阶段仅实现本地文件型 registry/manager，没有新增 UI、API endpoint 或 tool surface；后续记录见下方 2026-05-11 安全修复与最小 Surface 补齐。
- 第一阶段 server 启动时会确保两个内置样例卡存在，但不会自动执行 health check；后续记录见下方 health runner 骨架。
- `qq-mail-himalaya` 仍是 `candidate`，背景 watch 必须等用户确认 mailbox/query/cadence 后再提升为 `active`。
- `a-stock-market-data` 是公共 read-only source，Watch 可引用其 `fetch_quotes`/`fetch_rankings` capability，但仍禁止交易、券商账号、下单等语义。
- adapter revision 的对比、升级、回滚已经有类型落点，但本次最小闭环未实现自动 revision 评测器。

## 2026-05-11 安全修复与最小 Surface 补齐

### 本次目标

修复 Source Card 当前实现中的安全缺口，并补齐最小内部 service、tool surface 与 health runner 骨架。

### 实际修改的文件

- `packages/shared/src/types/source-card.ts`
  - 新增 `isSafeSourceEntityId()` / `assertSafeSourceEntityId()`，用于 Source Card 和 Observation 的路径安全校验。
- `packages/core/src/source-card/store.ts`
  - `get/delete/listObservations/appendObservation` 统一校验 `card id`、`sourceCardId`、`observation id`、`capabilityId`，拒绝路径穿越。
  - private/restricted 且 `metadata_only` 或附件 blocked 的 Source Card，拒绝落盘 body/raw/html/mime/payload/attachment 等 observation 字段。
  - `recordHealthResult` 拒绝未在 Source Card health contract 中声明的 check id。
  - health passed 时，`degraded` 恢复为 `active`；`broken` 恢复为 `verified`。
- `packages/core/src/source-card/service.ts`
  - 新增最小内部 service surface：`list/get/validate/validateStored/promote/retire/recordHealthResult/listObservations`。
  - service 返回 public view，只暴露 credential binding metadata，不暴露 credential ref。
- `packages/core/src/source-card/runner.ts`
  - 新增 health runner 骨架：只接收已产生的 health result，并按 Source Card health check contract 记录结果；不执行 CLI/API/browser/direct adapter。
- `packages/core/src/tool/source-card.ts`
  - 新增 `source_card` 管理工具，只允许 `list/get/validate/promote/retire`。
  - 明确不读取邮箱、不拉取股票数据、不执行 source adapter、不记录 health result。
- `apps/server/src/main.ts`
  - 初始化 `SourceCardService`，注册 `SourceCardTool`，并在 `ZeroOS` 暴露 `sourceCardService`。
- `apps/server/src/__tests__/main-integration.test.ts`
  - 更新 server 集成测试中的注册 tool 数量与 `source_card` 断言。
- `packages/core/src/source-card/__tests__/manager.test.ts`
  - 新增路径穿越拒绝、private observation 内容拒绝、health degraded 恢复 active 的测试。
- `packages/core/src/source-card/__tests__/service-runner.test.ts`
  - 新增 service surface、credential ref 不外露、health runner 只记录 health observation 的测试。
- `packages/core/src/tool/__tests__/source-card.test.ts`
  - 新增 tool surface 不外露 credential ref、只允许管理动作、拒绝 health/source 执行动作的测试。

### 关键设计决策

- 路径安全在 store 层强制执行，而不是只依赖上层调用方。
- private source 的 observation 安全策略在 manager 写入前执行；不做“写入后再清理”。
- service/tool surface 默认返回 public view；credential reference 仍可由底层 manager/runner 使用，但不从管理 API/tool 输出。
- health runner 不接受 adapter executor，不接入 scheduler，不启动 Agent，也不执行真实数据源读取；它只验证 check id 并记录外部提供的 health result。

### 验证命令和结果

- `bun test packages/core/src/source-card/__tests__/manager.test.ts`
  - 结果：11 pass，0 fail。
  - 覆盖：路径穿越拒绝、private metadata-only observation 拒绝正文/附件、health check contract、health recovery、watch/credential 边界。
- `bun test packages/core/src/source-card/__tests__/service-runner.test.ts`
  - 结果：4 pass，0 fail。
  - 覆盖：service surface、credential ref 不外露、health runner 只记录 health observation、不产生业务 data observation。
- `bun test packages/core/src/tool/__tests__/source-card.test.ts`
  - 结果：3 pass，0 fail。
  - 覆盖：tool surface 不外露 credential ref、只允许管理动作、拒绝 health/source 执行动作。
- `bun test packages/shared/src/__tests__/source-card.test.ts`
  - 结果：6 pass，0 fail。
- `bun test apps/server/src/__tests__/main-integration.test.ts`
  - 结果：11 pass，0 fail。
  - 覆盖：server 启动后注册 16 个工具并包含 `source_card`。
- `bun run check`
  - 结果：通过。
- `bunx biome check packages/shared/src/types/source-card.ts packages/core/src/source-card/store.ts packages/core/src/source-card/service.ts packages/core/src/source-card/runner.ts packages/core/src/source-card/index.ts packages/core/src/source-card/__tests__/manager.test.ts packages/core/src/source-card/__tests__/service-runner.test.ts packages/core/src/tool/source-card.ts packages/core/src/tool/__tests__/source-card.test.ts packages/core/src/index.ts apps/server/src/main.ts apps/server/src/__tests__/main-integration.test.ts`
  - 结果：通过。

### 剩余风险或后续建议

- 当前 health runner 只是记录骨架，尚未接入真实 adapter probe；接入时必须继续保持不由 scheduler/watch 保存凭证。
- 当前 tool surface 是 Agent tool，不是 HTTP API；如果未来加 Web/API endpoint，应复用 `SourceCardService` 的 public view，避免重新暴露 credential ref。
- private metadata-only 内容拦截使用字段名策略；后续如引入结构化 mail schema，应把正文/附件字段显式标注并由 schema 驱动拦截。

## 2026-05-11 Private Observation 字段拦截补漏

### 本次目标

修复 private/restricted 且 `metadata_only` 或 attachment blocked Source Card 的 observation 字段拦截缺口，补齐正文和附件内容字段别名。

### 实际修改的文件

- `packages/core/src/source-card/store.ts`
  - 正文字段拦截补充：`mailBody`、`messageBody`、`emailBody`、`contentBody`。
  - 附件字段拦截补充：`attachmentText`。
- `packages/core/src/source-card/__tests__/manager.test.ts`
  - 新增断言证明 `mailBody` 和 `attachmentText` 会被 private metadata-only Source Card 拒绝。
- `docs/source-card-implementation-log.md`
  - 记录本次补漏和验证结果。

### 安全边界

- 未读取真实私人邮件。
- 未执行 `himalaya`。
- 未修改 Source Card 大架构。

### 验证命令和结果

- `bun test packages/core/src/source-card/__tests__/manager.test.ts`
  - 结果：11 pass，0 fail。
  - 覆盖：`mailBody` 和 `attachmentText` 被 private metadata-only Source Card 拒绝。
- `bun run check`
  - 结果：通过。
- `bunx biome check packages/core/src/source-card/store.ts packages/core/src/source-card/__tests__/manager.test.ts docs/source-card-implementation-log.md`
  - 结果：通过。

## 2026-05-11 Read-only Web UI / API 第一版

### 本次目标

实现 Source Card 的第一版只读产品入口，让 Web UI 能查看 Source Cards 列表与详情，同时保持本阶段不提供 promote/retire mutation、不执行真实 health probe、不运行 CLI/API adapter、不读取私人邮件正文、不修改凭证。

### 已读取的关键上下文

- `/Users/v1ki/.codex/skills/frontend-skill/SKILL.md`
- `docs/source-card-ui-ux.md`
- `docs/source-card-implementation-log.md`
- `packages/core/src/source-card/service.ts`
- `packages/core/src/source-card/store.ts`
- `packages/core/src/tool/source-card.ts`
- `apps/web/src/api/routes.ts`
- `apps/web/src/app/router.tsx`
- `apps/web/src/app/components/layout/Sidebar.tsx`
- `apps/web/src/app/routes/tools.tsx`
- `apps/web/src/app/routes/memory.tsx`

### 实际修改的文件

- `packages/core/src/source-card/service.ts`
  - `toPublicSourceCard()` 在隐藏 `credentials` 的基础上，也从 public health evidence 中去掉 `credentialRef` 和 `credentialLeaseId`。
- `apps/web/src/api/routes.ts`
  - 新增 `GET /api/source-cards`。
  - 新增 `GET /api/source-cards/:id`。
  - 新增 `GET /api/source-cards/:id/observations?summary=1`。
  - observations API 只返回 summary rows，不返回 observation `data` 或 evidence `details`。
- `apps/web/src/app/routes/source-cards.tsx`
  - 新增 `/source-cards` 列表工作台。
  - 新增 `/source-cards/$id` 详情视图。
  - 展示 identity、lifecycle、capabilities、adapter revision、credential binding summary、privacy、health 和 observation summary。
  - 私有邮箱展示 metadata-only/body hidden/attachments blocked/credential refs hidden。
  - 公共股票源展示 public read-only/no trading/no broker/order/rebalancing。
- `apps/web/src/app/router.tsx`
  - 注册 Source Cards 列表与详情路由。
- `apps/web/src/app/components/layout/Sidebar.tsx`
  - 新增 `Sources` 入口。
- `apps/web/src/api/__tests__/routes.test.ts`
  - 覆盖 Source Card read-only API、public view redaction、observation summary 不含 raw data、missing 404。
- `apps/web/src/app/routes/source-cards.test.tsx`
  - 覆盖列表和详情的关键安全文案、Watch eligibility、QQ 邮箱 candidate/private 与 A 股 active/public 的区分。
- `docs/source-card-implementation-log.md`
  - 记录本次实现过程。

### 关键设计决策

- Web API 复用 `SourceCardService` public view，不暴露 `credentials`。
- API 层不实现 promote/retire，不提供 health probe 执行入口，只提供 read-only list/get/observation summary。
- Observation endpoint 只做摘要，不做 raw observation 或日志浏览器，避免高频数据和私人内容进入 UI。
- 前端首屏是表格/列表工作台，状态和 Watch eligibility 都有文字标签，不只依赖颜色。
- 详情页右侧 inspector 只展示 credential binding type、inject mode、scope 和 reference-present 状态，不展示引用值。

### 安全边界

- 未执行 `himalaya`。
- 未拉取真实股票数据。
- 未读取私人邮件正文或附件。
- 未实现自动交易、自动发送邮件、远端写操作。
- 未修改 scheduler。
- 未新增 Watch 创建向导。
- UI/API 不展示 `binding.ref`、credential ref、token、cookie、password、authorization。

### 验证命令和结果

- `bun test packages/core/src/source-card/__tests__/service-runner.test.ts`
  - 结果：5 pass，0 fail。
  - 覆盖：SourceCardService public view 不外露 credential refs，包括 health evidence 中的 `credentialRef` / `credentialLeaseId`。
- `bun test apps/web/src/api/__tests__/routes.test.ts`
  - 结果：35 pass，0 fail。
  - 覆盖：Source Card list/get/observation summary API、public view redaction、缺失 Source Card 404、`source_card` tool 注册数。
- `bun test apps/web/src/app/routes/source-cards.test.tsx`
  - 结果：4 pass，0 fail。
  - 覆盖：Watch eligibility、列表展示、QQ 邮箱 private/candidate 安全文案、A 股 public/active read-only/no-trading 文案。
- `bun run check`
  - 结果：通过。
- `bunx biome check --write packages/core/src/source-card/service.ts apps/web/src/api/routes.ts apps/web/src/api/__tests__/routes.test.ts apps/web/src/app/routes/source-cards.tsx apps/web/src/app/routes/source-cards.test.tsx apps/web/src/app/router.tsx apps/web/src/app/components/layout/Sidebar.tsx`
  - 结果：通过，并格式化 3 个文件。
- `bunx biome check packages/core/src/source-card/service.ts apps/web/src/api/routes.ts apps/web/src/api/__tests__/routes.test.ts apps/web/src/app/routes/source-cards.tsx apps/web/src/app/routes/source-cards.test.tsx apps/web/src/app/router.tsx apps/web/src/app/components/layout/Sidebar.tsx`
  - 结果：通过。
- `bun run build:web`
  - 结果：通过；Vite 仅提示 bundle chunk size warning。
- 临时 `PORT=3101` Zero Web 服务验证：
  - `GET /api/source-cards` 返回两个样例 Source Card。
  - `GET /source-cards` 返回 200。
  - `GET /source-cards/qq-mail-himalaya` 返回 200。
  - `GET /api/source-cards/qq-mail-himalaya` 敏感字段扫描无 `external:himalaya/account/qq`、`credentialRef`、`credentialLeaseId`、`credentials`、token/cookie/password/authorization 命中。
  - Playwright 截图通过：`/tmp/source-cards-list.png`、`/tmp/source-cards-qq.png`、`/tmp/source-cards-stock.png`。

### 未解决风险或后续建议

- 目前只读 UI 不支持 promote/retire 审批；后续实现 mutation 时必须继续复用 public view 和显式 reason/scope confirmation。
- 当前 observations 只展示摘要；如果未来展示公共数据样本，需要由 observation contract 明确允许，并继续默认屏蔽 private source raw content。

## 2026-05-11 Read-only API Public View Hardening

### 本次目标

修复 Source Card read-only API 的 public view 泄漏风险，继续保持不实现 promote/retire、不执行 health probe、不运行 `himalaya`、不读取私人邮件、不拉取真实股票数据、不修改 Watch/scheduler。

### 已读取的关键上下文

- `packages/core/src/source-card/service.ts`
- `apps/web/src/api/routes.ts`
- `apps/web/src/api/__tests__/routes.test.ts`
- `apps/web/src/app/routes/source-cards.tsx`
- `docs/source-card-implementation-log.md`

### 实际修改的文件

- `packages/core/src/source-card/service.ts`
  - 将 `SourceCardPublicView` 收紧为真正的 public shape。
  - adapter revision 只返回 `id/status/mode/entrypointSummary/parser/schemaKeys/timeout/rateLimit/templateCounts`。
  - 不再返回 `commandTemplate`、`endpointTemplates`、`validation.sampleQueries`。
  - public health evidence 不再返回 `credentialRef`、`credentialLeaseId`、`message`、`details`。
- `apps/web/src/api/routes.ts`
  - observation summary evidence 不再返回 `message`、`details` 或 raw observation `data`。
- `apps/web/src/app/routes/source-cards.tsx`
  - UI 改为消费 public adapter summary，展示 entrypoint summary 和 template counts。
- `packages/core/src/source-card/__tests__/service-runner.test.ts`
  - 覆盖 public health evidence 与 adapter summary 的脱敏/收敛边界。
- `apps/web/src/api/__tests__/routes.test.ts`
  - 覆盖 Source Card list/get 不包含 command template、endpoint templates、sample queries、message/details。
  - 覆盖 observation summary 不包含 raw data、message/details。
  - 保留 QQ 邮箱 external credential ref 不外露和 A 股 read-only/no-trading 信息断言。
- `docs/source-card-implementation-log.md`
  - 记录本次 hardening。

### 关键设计决策

- 收敛点放在 `SourceCardService.toPublicSourceCard()`，避免 Web/API 或未来 UI 调用方各自手动删字段。
- adapter public view 保留可诊断的结构化摘要，不返回可执行命令模板、完整 endpoint 模板或 sample query。
- observation summary 继续只做摘要，不承担 raw data viewer 角色。

### 安全边界

- 未实现 promote/retire。
- 未实现真实 health probe。
- 未执行 `himalaya`。
- 未读取私人邮件。
- 未 fetch 真实股票数据。
- 未修改 Watch/scheduler。
- credential 仍然只通过 `credentialBindings` 摘要展示，不返回 `credentials`、`binding.ref`、`credentialRef`、`credentialLeaseId`。

### 验证命令和结果

- `bun run check`
  - 结果：通过。
- `bun test apps/web/src/api/__tests__/routes.test.ts`
  - 结果：35 pass，0 fail。
  - 覆盖：API list/get/observation summary 的 public view hardening。
- `bun test apps/web/src/app/routes/source-cards.test.tsx`
  - 结果：4 pass，0 fail。
  - 覆盖：UI 仍能展示 QQ candidate/private 与 A 股 active/public/read-only/no-trading。
- `bun test packages/core/src/source-card/__tests__/service-runner.test.ts`
  - 结果：5 pass，0 fail。
  - 覆盖：service public view 不外露 adapter templates、sample queries、credential refs、health message/details。

### 未解决风险或后续建议

- 当前 hardening 仍保留 capability input/output schema。若后续 schema 本身可能带私人示例值，应引入 schema-level sanitizer 或 schema allowlist。

## 2026-05-11 Promote/Retire Approval API and UI

### 本次目标

实现 Source Card promotion/retire 的最小审批闭环：Web API 和详情页 UI 可以明确审批 promote/retire，并记录结构化 promotion payload。范围内不执行真实 health probe、不运行 `himalaya`、不读取私人邮件、不 fetch 股票真实数据、不创建 Watch、不修改 scheduler。

### 已读取的关键上下文

- `/Users/v1ki/.codex/skills/frontend-skill/SKILL.md`
- `docs/source-card-ui-ux.md`
- `docs/source-card-implementation-log.md`
- `packages/core/src/source-card/service.ts`
- `packages/core/src/source-card/store.ts`
- `apps/web/src/api/routes.ts`
- `apps/web/src/app/routes/source-cards.tsx`
- 关联类型、tool、API/UI 测试文件

### 实际修改的文件

- `packages/shared/src/types/source-card.ts`
  - `SourceCardPromotion` 增加 `reviewedCapabilityIds` 和 `privateScopeConfirmation`。
- `packages/core/src/source-card/service.ts`
  - `promote` 改为接收结构化 `SourceCardPromoteRequest`。
  - promote 要求 reason、reviewedCapabilityIds，并要求所有 watchable capability 已被 review。
  - private/restricted source promote 必须提供 metadata-only confirmation。
  - private promote 拒绝 body access 或 attachment access approval。
  - `retire` 增加非空 reason 校验。
- `packages/core/src/source-card/index.ts`
- `packages/core/src/index.ts`
  - 导出 promote payload 相关类型。
- `packages/core/src/tool/source-card.ts`
  - `source_card` 管理工具同步改为结构化 promote 输入，不保留只传 reason 的 promote 调用路径。
- `apps/web/src/api/routes.ts`
  - 新增 `POST /api/source-cards/:id/promote`。
  - 新增 `POST /api/source-cards/:id/retire`。
  - mutation 响应继续只返回 `SourceCardService` public view。
- `apps/web/src/app/routes/source-cards.tsx`
  - Source Card 详情页右侧增加审批操作区。
  - 新增 Promote drawer，包含 schema/state/capability/credential/privacy/prohibited/private metadata-only checklist。
  - 新增 Retire dialog，要求 reason，并说明 retire 影响。
  - promote/retire 成功后刷新详情数据和 observation summary，并通知列表页重拉 Source Cards 状态。
- `packages/core/src/source-card/__tests__/service-runner.test.ts`
- `packages/core/src/tool/__tests__/source-card.test.ts`
- `apps/web/src/api/__tests__/routes.test.ts`
- `apps/web/src/app/routes/source-cards.test.tsx`
  - 增加结构化 promote、private scope failure、public view redaction、UI drawer/dialog 覆盖。
- `docs/source-card-implementation-log.md`
  - 记录本次实现过程。

### 关键设计决策

- Source Card promotion 是低频审批状态变更，记录在 `promotion` 字段；高频数据仍进入 Observation，不通过反复改 Source Card 表达。
- API 只调用 SourceCardService，不引入真实 adapter 执行、health probe、Watch 创建或 scheduler 行为。
- private/restricted source 的审批 payload 只能确认 metadata-only；body 和 attachment 后台访问在 service 层硬拒绝。
- Web mutation 返回 public view，继续由 service 层统一去除 credential refs、command templates、endpoint templates、sample queries、health message/details。
- UI 抽屉展示 credential binding summary，而不是 credential ref；用户审批的是 reference-presence 和 scope 摘要，不接触密钥值。

### 安全边界

- 未执行 `himalaya`。
- 未读取私人邮件正文或附件。
- 未 fetch 股票真实数据。
- 未实现自动交易、自动下单、自动发送邮件或远端写操作。
- 未创建 Watch。
- 未修改 scheduler。
- API/UI 不返回或渲染 `credentials`、`binding.ref`、`credentialRef`、`credentialLeaseId`、secret、token、cookie、password、authorization。
- promote/retire 响应不包含 `commandTemplate`、`endpointTemplates`、`sampleQueries`、health `message/details`。

### 验证命令和结果

- `bun test packages/core/src/source-card/__tests__/service-runner.test.ts packages/core/src/tool/__tests__/source-card.test.ts`
  - 结果：9 pass，0 fail。
  - 覆盖：structured promote、private metadata-only enforcement、source_card tool 的结构化 promote、public view credential redaction。
- `bun test apps/web/src/app/routes/source-cards.test.tsx`
  - 结果：6 pass，0 fail。
  - 覆盖：Promote drawer private metadata-only 确认项、UI 不渲染 credential ref、Retire dialog reason required。
- `bun test apps/web/src/api/__tests__/routes.test.ts`
  - 结果：39 pass，0 fail。
  - 覆盖：public verified source promote 成功、private source 缺少 confirmation 失败、private body/attachment approval 失败、retire reason required、mutation public view redaction。
- `bun run build:web`
  - 结果：通过；Vite 仅提示 bundle chunk size warning。
- `bun run check`
  - 结果：通过。

### 未解决风险或后续建议

- 当前 promote 只记录审批 payload 并激活 Source Card，不执行 health probe。后续如接真实 probe，必须保持 trace 脱敏和 private metadata-only 默认边界。

## 2026-05-12 LLM-guided Source Card Preflight

### 本次目标

实现 Source Card 的 LLM-guided preflight MVP：当 Agent 面对像是查询已知外部数据源的用户请求时，先通过现有 `source_card` 管理工具查看 Source Cards，再由 LLM 判断是否应参考某张卡的状态、隐私策略、禁止动作和出处边界。Source Card 当前定位是 source boundary，不是统一数据查询入口。

### 实际修改的文件

- `packages/core/src/agent/prompt.ts`
  - 在 tool rules 中为 `source_card` 增加 preflight 规则。
  - 明确外部数据源查询优先 `source_card list/get`。
  - 明确 active/public Source Card 只允许后续前台查询工具在 Source Card 边界内继续执行。
  - 明确 private/restricted/candidate Source Card 应说明 blocker，不得绕过后台读取。
  - 明确 Source Card 不是执行器，不代表已经能自动获取数据。
- `packages/core/src/agent/__tests__/prompt.test.ts`
  - 覆盖外部数据查询应先检查 Source Cards。
  - 覆盖 private/restricted/candidate Source Card 不应被绕过。
  - 覆盖 Source Card 是边界和出处，不是执行器。
- `docs/source-card-implementation-log.md`
  - 记录本次定位调整。

### 关键设计决策

- 不新增 `SourceResolver`，不新增 `source_query`，不修改 Source Card schema。
- 匹配判断先交给 LLM：Agent 通过 `source_card list/get` 读取现有卡，再判断用户请求是否落在某张卡的边界内。
- Source Card 只提供可审计边界：状态、sensitivity、privacy、prohibitedActions、capabilities、credential binding summary 和来源。
- 数据获取仍使用现有前台工具，例如 `fetch`、`bash`、`browser`，但必须受匹配 Source Card 的 privacy/prohibitedActions 约束。

### 安全边界

- 未实现 Watch binding。
- 未修改 scheduler。
- 未新增后台定时任务。
- 未新增自动 health runner。
- 未实现 QQ 邮箱后台 metadata adapter validation。
- 未新增 SourceResolver 或 `source_query`。
- 未修改 Source Card schema。
- 未读取私人邮件正文或附件。
- 未运行 `himalaya`。

### 验证命令和结果

- `bun test packages/core/src/agent/__tests__/prompt.test.ts`
  - 结果：52 pass，0 fail。
- `bun test packages/core/src/tool/__tests__/source-card.test.ts`
  - 结果：3 pass，0 fail。
- `bun test packages/core/src/tool/__tests__/source-card.test.ts packages/core/src/source-card/__tests__/service-runner.test.ts`
  - 结果：9 pass，0 fail。
- `bun run check`
  - 结果：通过。

### 未解决风险或后续建议

- 当前只是 prompt/tool-rule 层面的 preflight 指引，不是强制执行网关。
- Source Card 与后续 `fetch/bash/browser` 的严格联动仍依赖 Agent 遵守规则，尚未在 runtime 层阻断绕过行为。
