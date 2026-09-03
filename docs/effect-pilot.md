# Effect-TS 试点：packages/secrets 的 keychain 模块

这份文档记录 Effect-TS 在本仓库的第一次试点改造：范围、架构决策、踩过的坑（含一次真实事故）、以及后续推广路径。

## 试点范围

- 改造对象：`packages/secrets/src/keychain.ts`（macOS Keychain 读写 master key）。
- 不变的部分：公共 API 签名（`getMasterKey/setMasterKey/deleteMasterKey` 返回 Promise）、错误消息字符串、`ZERO_MASTER_KEY_BASE64` env 优先级语义、Keychain 条目标识（service `com.zero-os.vault` / account `master-key`）、vault.ts 与 filter.ts 全部未动。
- 依赖：仅新增 `effect`（当前 ^3.22.1），不引入 `@effect/platform`、`@effect/test`。

## 架构

```
调用方 (Promise + try/catch, 零改动)
   │
   ▼
getMasterKey() 等公共函数 ── 薄适配器：Effect.runPromiseExit + Cause.squash
   │
   ▼
Keychain (Context.Tag service) ── get/set/delete: Effect<_, TypedError, Keychain>
   │
   ▼
KeychainLive (Layer) ── 每个方法先查 env 旁路，再走 Bun.spawn('security', ...)
                          └─ 子进程用 Effect.acquireRelease 包裹（中断时 kill 兜底）
```

关键决策：

1. **类型化错误**：`MasterKeyMissingError`、`KeychainWriteError`（`Data.TaggedError`），消息与旧实现逐字一致。
2. **单一 Live layer 而非两个可切换 layer**：旧实现是"每次调用时"检查 env，`set` 会改写 env、`delete` 会删 env——这个语义必须在方法内部实现，不能在组合时二选一。
3. **适配器拒绝值必须是原始错误实例**：`Effect.runPromise` 的拒绝值是 `FiberFailure` 包装（Effect 3 的文档化行为），会让调用方的 `err.message` 出现 `MasterKeyMissing: ` 前缀漂移。适配器改用 `Effect.runPromiseExit` + `Cause.squash`（Fail → 原始错误，Die → 原始异常，与旧行为零漂移）。
4. **acquireRelease 需要 `Effect.scoped`**：`acquireRelease` 会在类型上要求 `Scope` 环境，service 方法签名是 `R = never`，所以每个子进程操作用 `Effect.scoped(...)` 包裹以消除该要求。

## 参考源码（repos/effect）

写 Effect 代码时**不要凭记忆猜 API**。仓库通过 git subtree 内嵌了 Effect 完整源码：

- 位置：`repos/effect`，pin 在 tag `effect@3.22.1`（与安装的依赖版本精确一致）。
- 用法：核对 API 时读 `repos/effect/packages/effect/src/<Module>.ts` 与其 `test/`；`Effect.void` 这类导出（保留字经 `export { _void as void }` 重命名导出）只能从源码确认。
- 只读：`repos/` 下的文件不可编辑、不可 import（应用代码只从 `effect` 包导入），规则见根 AGENTS.md "Vendored Reference Sources"。
- 升级依赖时同步更新参考：`git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<新版本> --squash`。

## 事故记录（2026-09-03）

试点第一版测试文件因 `beforeAll` 钩子执行顺序问题，导致 env 旁路在 set/delete 测试时失效，测试带着默认参数对**真实** Keychain 条目执行了删除。master key 无法恢复，最终重新 `bun zero init` 并重新录入密钥。

教训（已固化为规则）：

1. 触及真实 Keychain 的测试，**任何写操作必须显式传隔离 target**（现有测试已全部改为传 `com.zero-os.vault.effect-test.*`），不能依赖"env 旁路应该生效"这类假设。
2. 测试文件里多个 describe 共享 `process.env` 时，每个测试必须自设、自查、自清 env，不依赖钩子顺序。
3. 备份 master key（`security find-generic-password -s com.zero-os.vault -a master-key -w` 输出存入密码管理器）是唯一可靠的灾备手段；本地快照不备份数据卷，Time Machine 仅本地模式时同样指望不上。

### 预防措施（已落地为代码，不依赖自觉）

| 层级 | 机制 | 位置 |
|---|---|---|
| 结构级 | `KeychainLive` 在 `NODE_ENV=test`（`bun test` 自动设置）下拒绝 set/delete 生产条目（`com.zero-os.vault`/`master-key`），抛 `KeychainTestGuardError`，在任何 `security` 子进程 spawn 之前拦截。隔离 target 与 stub Layer 不受影响，CLI/生产运行（无 `NODE_ENV=test`）行为不变 | `keychain.ts` |
| 金丝雀 | 两份 keychain 测试套件 beforeAll/afterAll 对生产条目做 sha256 摘要 + 存在性比对，套件期间任何路径（含未来绕过 `KeychainLive` 的直接 `security` 调用）造成的改动都会让测试失败。摘要之外不打印、不落盘任何密钥内容 | `__tests__/helpers/keychain-canary.ts` |
| 行为测试 | 逐字重放事故场景（env 旁路失效 + 默认 target 调 `setMasterKey()`/`deleteMasterKey()`），断言被 guard 拒绝且真实条目未动 | `keychain-effect.test.ts` |
| 规则 | 上述要求写入根 AGENTS.md 安全规则第 5 条，约束后续 agent | `AGENTS.md` |

仍需用户侧配合：把当前 master key 备份进密码管理器（一次性），这样即使出现 guard 未覆盖的新路径，也能通过 `ZERO_MASTER_KEY_BASE64` 旁路恢复。

## 验证

- `bun run check`（全仓 tsc）通过，耗时与改造前持平（~6s）。
- `bun test packages/secrets` 22/22 通过，含真实 Keychain 往返集成测试（隔离条目）。
- 错误保真验证：缺失条目时拒绝值 `instanceof MasterKeyMissingError` 且 `.message` 与旧实现逐字一致。
- 生产路径实战：`bun zero init` 走新代码生成并存储 key 成功。

## 后续推广路径（未实施）

1. `packages/scheduler`：Effect Schedule + fiber 中断替代手写 setTimeout 重排（注意现有测试依赖私有方法，需重写）。
2. `apps/server` 的 `createSecretsRuntime` 改为消费 `Keychain` service，在 startup 组合根用 Layer 装配。
3. 视前两步结论决定是否推进 core 的工具子进程执行切片。
