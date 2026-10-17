# Prompt benchmark 原生平台接入验证

## 交付范围

`bun run prompt:bench run` 现在通过平台执行器运行原生插件，不再调用旧 worker 后再导入结果。

- 平台生成任务矩阵，管理并发和独立进程截止时间。
- `executeTask` 保留原工具循环，并将评分延迟到平台 evaluate 阶段；原 `executeTrial` API 作为兼容入口保留。
- `Context.model` 逐次记录 adapter.complete，包括空回复重试；`Context.tool` 逐次记录模拟工具的参数/结果摘要、状态、耗时及免费工具成本。
- `platform/results.jsonl` 是原生事实来源。根目录的兼容格式由过滤后的执行证据生成，错误/超时情况下的未知用量以平台格式为准。
- 默认工具预算为 256；可用 `--max-tool-calls` 设置。超预算会停止批次里尚未执行的工具。
- 平台新增独立进程执行器，超时终止不响应取消的 worker，恢复已完成调用和未完成请求的未知用量。

工具仍为模拟工具。评分仍是原机械检查，未新增双模型盲评或完整任务语义评分。模型调用数不含适配器内部 HTTP 重试。独立进程不是文件/网络权限沙箱，也不能取消已经提交到外部服务的工作。

## 自动验证

`bun test benchmarks/platform/src/__tests__ benchmarks/zero-runtime/src/prompt-bench/__tests__`：**65 通过、0 失败、263 个断言**。

新增测试核对：原生与兼容 API 的请求、工具顺序和评分相同；评分在 evaluate 阶段；空回复同请求重试；工具错误恢复；预算中断；实际响应模型不符；提供商异常用量未知；闭环外的收尾分类归入执行用量；快照漂移拒绝运行；独立进程并发隔离；强制终止不配合取消的进程并恢复部分用量。

`bun run check`、相关 Biome 检查和 `git diff --check` 通过。未变更生产 Session、系统提示词内容或真实工具实现。

## 三模型实际接入测试

输出：`.zero/benchmarks/prompt-native-smoke-20260906/`。

| 项目 | 设置/结果 |
|---|---|
| 模型 | chatgpt/gpt-5.5、chatgpt/gpt-5.6-sol、chatgpt/gpt-6-astra |
| 快照 | real-before-20260906 / real-after-20260906 |
| 任务 | real-file-path、closure-real-io-complete |
| 重复与并发 | 每组合 1 次；并发 3 |
| 预算 | 6 次模型调用、32 次工具调用、120 秒/试验；maxTokens 请求值 2048；同请求空回复重试最多 1 次 |
| 结果 | 12/12 通过，0 工具错误，0 空回复；6 对全部平局 |
| 原生用量 | 18 次模型调用，6 次模拟工具调用 |
| token | 未缓存输入 45,453；输出 737；缓存读取 0；推理 154（输出子集） |
| 缓存写入 | 12 次试验均未提供，保持 null，不能解释成 0 |
| 评审调用 | 0 次模型调用；本轮评分是本地机械检查 |

逐条核对原生/兼容记录的通过状态、模型请求和工具次数、所有已知用量；检查事件日志与证据 SHA-256。最终核对记录为 `verification.json`；早期 `native-verification.json` 的缓存写入字段显示已知小计 0 并另记 12 次未知，最终记录已明确改为 null。原平台结果始终保留 null，未修改原始调用记录。

- `platform/report.md`：分任务族的统一报告。
- `platform/results.jsonl`：12 条 `provenance.kind = native` 记录。
- `platform/comparison.json`：6 对的比较结果。
- `platform/trials/<id>/events.jsonl`：实际执行过程。
- `platform/trials/<id>/legacy-trial.json`：经过凭据过滤的完整任务与评分证据。

这是接入验证，只证明三种供应商路径在所选两个小任务上可以完成平台流程并对上账，不证明新提示词质量提升、所有任务迁移无误或完整 ZeRo Session E2E 通过。后续扩大题库使用同一入口即可。
