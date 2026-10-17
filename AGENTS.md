# ZeRo OS 项目约定

## 项目与入口
- Bun + TypeScript ESM monorepo，工作区位于 `apps/*`、`packages/*`。
- `apps/server`：启动、CLI 和运行时；`apps/web`：React/Vite UI 与 Web 服务；`apps/supervisor`：监督进程。
- `packages/*`：核心领域模块；`e2e/`：Playwright 测试。
- `.zero/` 是本地运行数据，包括日志、记忆、密钥和 agent 工作区，不按普通产品源码处理。

## 修改边界
- 按用户要求完成工作。执行请求包括实现与验证；分析请求保持分析范围。
- 修改前检查相关实现和已有差异。沿用现有模式、工具和包边界，采用最小完整改动，不做无关重构。
- 不覆盖或撤销已有改动。若修改与已有差异重叠、归属不清或无法安全保留，先说明冲突并询问。
- 默认保持公共导出、跨包接口和现有行为稳定。行为、接口或运维方式改变时，同步更新相关文档。
- 不用静默回退或宽泛异常捕获掩盖失败；保留 TypeScript 类型安全，遵循现有 Biome 配置。

## 数据与密钥
- 不输出、粘贴或提交密钥值；不直接编辑 `.zero/secrets.enc`。
- 不提交 `.zero/*`、`dist`、`node_modules` 或 `test-results`。
- Keychain 测试必须使用隔离的 `KeychainTarget` 或 stub，禁止写入或删除生产项：service `com.zero-os.vault`、account `master-key`。
- 保留 Keychain 测试前后的生产项摘要 canary 校验，不将密钥原文用于诊断输出。

## Effect 参考源码
- `repos/` 是只读上游参考；未经明确要求不修改，也不从中导入应用代码。
- 使用 Effect API 前，查阅 `repos/effect/packages/effect/` 对应实现与测试。
- 应用代码从正常依赖导入 Effect；参考源码版本应与安装依赖一致，更新前先核对两者。

## 验证
- 每次代码修改至少执行一种相关验证；TypeScript 修改默认运行 `bun run check`。
- 逻辑修改运行相关测试；UI、API、session 或 websocket 行为修改，在可行时运行相关 E2E。
- 新测试放在附近的 `__tests__/`。先运行最小相关检查，仅在风险、失败或未解决疑点需要时扩大范围。
- session、tool、memory 修改关注恢复行为与日志一致性；scheduler、channel 修改关注兼容性与错误呈现。
- 区分本次失败、既有失败和未验证事项，不将未验证描述为通过。

## 常用命令
- 类型检查：`bun run check`
- 格式与静态检查：`bun run lint`
- 单元和集成测试：`bun run test`
- E2E：`bun run test:e2e`
- Web 开发与构建：`bun run dev:web`、`bun run build:web`
- ZeRo 运维命令使用前查阅 `docs/zero-cli.md`。
