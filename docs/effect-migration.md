# Effect-TS 全仓迁移计划

目标（2026-09-03 用户指令）：将所有后端模块切换到 Effect-TS。`apps/web`（React UI）不在范围——Effect 是后端运行时形态，前端继续用 React 生态。

## 判据：一个模块"已切换"是什么意思

按三个试点（secrets/scheduler/server 组合根，见 `docs/effect-pilot.md`）确立的模式：

1. **并发与定时**：interval/timeout/轮询循环跑在 fiber 上（`Effect.runFork` + `Effect.sleep`），生命周期用 `Fiber.interrupt` 统一取消。
2. **失败路径**：跨模块边界的失败用 `Data.TaggedError` 类型化暴露（边界处适配回既有 Promise/Error 契约）。
3. **组合根**：模块对外服务（如 `Keychain`）以 Context.Tag + Layer 装配，测试可注入 stub Layer。
4. **公共 API 稳定**：跨包契约（Promise 签名、错误消息）不变，调用方零改动。

反向判据（同试点结论）：**纯同步、无定时、无资源生命周期的代码不迁移**——把同步逻辑包进 Effect 只有仪式没有收益。此类文件在状态表标注 N/A-by-design。

## 架构主线

模块级迁移的解锁条件是**应用组合根的 fiber 运行时**：长活任务（scheduler、heartbeat、channel 重连、memory 后台任务）归属统一 root Scope，中断即清理。core 工具执行 fiber 化（abort→`Fiber.interrupt`、timeout→`Effect.timeout`、子进程清理→`acquireRelease`）是该主线的旗舰项，也是爆炸半径最大的一项，压轴做。

## 模块状态表

| 模块 | LOC | 异步面 | 状态 | 切换内容 |
|---|---|---|---|---|
| packages/secrets | 445 | 中 | ✅ keychain；vault/filter 同步层 N/A | 已完成（试点 #1） |
| packages/scheduler | 261 | 中 | ✅ | fiber 定时器（试点 #2） |
| apps/server 组合根（secrets 部分） | — | — | ✅ | Keychain Layer 装配（试点 #3） |
| packages/supervisor | 526 | 低 | ✅ 本次 | HeartbeatWriter 间隔 fiber 化 + fail-fast 保留；waitForReady 的 AbortSignal 轮询与 RepairEngine/GitOps 业务逻辑 N/A |
| packages/observe | 4341 | **零** | N/A-by-design | 纯同步 sqlite 持久层；除非引入异步 I/O 否则不迁移 |
| packages/memory | 3069 | 高 | ✅ 本次 | usage 防抖落盘 fiber 化（stop() 接入 shutdown）；embedding 错误 `Data.TaggedError` 类型化；`withIdLock` promise 链互斥保持不变（反向判据：调用方是 Promise、无中断传播，换 semaphore 只有仪式还会引入锁表泄漏） |
| packages/model | 6957 | 高 | ⬜ | OAuth token 刷新定时器 fiber 化；provider 适配器失败类型化 |
| packages/channel | 7725 | 高 | ⬜ | qr-login 轮询状态机、channel 重连循环 fiber 化 |
| packages/core | 19450 | 最高 | ⬜ 压轴 | 工具执行 fiber 化 runner（见 effect-pilot.md 重启条件）+ 会话循环 |
| apps/server 其余组合根 | 11292 | 高 | ⬜ | root Scope/Runtime 装配，归属各模块 fiber |
| packages/shared | 1803 | 极低 | 预计 N/A | 类型与纯工具为主 |
| apps/supervisor | 554 | 低 | ⬜ | 跟随 supervisor 包结论 |

## 迁移日志

- 2026-09-03：计划建立；supervisor 完成（HeartbeatWriter interval→fiber，`Cause.isInterrupted` 区分 stop 与故障，fiber 失败经 observer 抛出保持 fail-fast——探针验证过两种路径）。
- 2026-09-03：memory 完成。`MemoryUsageTracker` 防抖落盘定时器→fiber（单发 sleep + observer 内 fire-and-forget flush，与旧 setTimeout 回调"先清 timer 再 void flush"逐字等价）；新增 `stop()` 并接入 startup shutdown（旧 timer unref 不阻止退出，fiber 的 sleep 持有普通定时器引用，优雅退出必须经 shutdown 中断）。`EmbeddingClient` 三类失败改 `Data.TaggedError`（消息逐字保持，现有 rejects 断言零改动）。附带修复 usage-stats 测试两处时序脆弱断言（`score === 1` 依赖 record→snapshot 间 0ms，首次 runFork ~0.8ms 即可击穿——探针证实）。`withIdLock` 保持 promise 链。验证：memory 141/141（x3 稳定）、apps/server 217/217、core 套件与基线一致（3 个既有失败，stash 对照确认）。
