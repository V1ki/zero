# v1 验证记录（2026-09-06）

本文保留平台首版的历史验证。随后完成了 prompt 原生接入、65 项相关测试和三模型 12 次实际调用试验，见 [原生接入验证](../../docs/prompt-benchmark-native-20260906.md)。

本次验证平台的执行、记账、导入与比较机制，不重新判断提示词优劣，不声称评审模型可靠性已经验证。

## 自动检查

- `bun test benchmarks/platform/src/__tests__ benchmarks/zero-runtime/src/prompt-bench/__tests__`：55 项通过，0 失败；其中平台新增 15 项，既有提示词相关 40 项。
- `bun run check`：通过。
- Biome 检查平台、三个接入入口及 package.json：通过。
- `git diff --check`：通过。
- `bun install --lockfile-only --ignore-scripts --frozen-lockfile`：通过；锁文件仅新增平台 workspace 的记录，没有升级依赖。

测试覆盖真实文件产物、已知错例、证据缺失、执行/评审分账、错误和超时后的用量、预算拦截、清理、环境及评分器漂移、重复记录、未知费用、敏感正文不自动进入事件、三类历史格式适配。

## 本地实际执行

结果根目录：`.zero/benchmarks/platform-v1-20260906/`。

| 验证 | 输入/方式 | 结果 |
|---|---|---|
| 原生插件 | file-summary，真实本地文件，2 版本 × 3 次 | 正确版 3/3 通过，故意漏算版 0/3；对照 3 次均识别改善 |
| 计划生成 | 同插件元数据 | 生成 6 项计划，不调用生命周期钩子 |
| 提示词结果导入 | real-replay-reviewed-20260906 的 36 条历史记录 | 35 条保留旧机械通过；配对结果 17 平、1 退步，与原结果一致 |
| 真实 Session 结果导入 | 2026-05-13-qwen-local-artifact-360 的历史 summary | 1 条导入，保留原验证通过；不重新打开/执行历史产物 |
| 报告重建 | 从原生 results.jsonl 生成新目录 | 统一报告、质量指标和分阶段用量生成成功 |

可查阅：

- `file-report/report.md`：实际文件执行报告，原始事件和文件保存在 `file-control/`。
- `prompt-final/report.md`：主任务和收尾分类已拆开的历史对照报告。
- `runtime-final/report.md`：真实 Session 历史结果。
- `comparison-final.json`：36 条提示词历史结果的最终配对。

压缩提示词适配器用隔离测试样本验证；本次没有调用其供应商重新运行，也没有验证自动导出钩子所处的付费执行全流程。三类入口的统一导出通过类型检查及适配器测试，原命令保留原始输出。

本次无新增付费模型请求、真实图片生成、草稿发布或生产 Session 修改。尚未覆盖远程执行器、自动双评、强制终止不配合取消的插件，以及其他旧 benchmark 的迁移。相关边界见 README。
