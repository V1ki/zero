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
