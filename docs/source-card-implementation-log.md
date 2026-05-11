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

- 当前仅实现本地文件型 registry/manager，没有新增 UI、API endpoint 或 tool surface；下一步需要决定 Source Card 的用户审批入口和管理界面。
- 当前 server 启动时会确保两个内置样例卡存在，但不会自动执行 health check；后续可以把 health runner 接入现有 runtime，但仍应保持与 scheduler/watch 分离。
- `qq-mail-himalaya` 仍是 `candidate`，背景 watch 必须等用户确认 mailbox/query/cadence 后再提升为 `active`。
- `a-stock-market-data` 是公共 read-only source，Watch 可引用其 `fetch_quotes`/`fetch_rankings` capability，但仍禁止交易、券商账号、下单等语义。
- adapter revision 的对比、升级、回滚已经有类型落点，但本次最小闭环未实现自动 revision 评测器。
