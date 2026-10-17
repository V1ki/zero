# 空回复定位：2026-09-06

已定位到接口返回空完成，以及 benchmark 未模拟运行时重试这两层。当前没有证据证明是解析器丢掉了这些回复，也没有证据证明删除文档伪指令就能消除空回复。本轮没有修改生产提示词或运行时行为。

## 原始事件证据

从进阶试验中提取 GPT-5.6 Sol 新版失败轨迹，仅重放最后一次请求，不重新执行任何工具。诊断记录正文长度与哈希、事件类型和状态，不保存请求头、凭据或加密推理正文。

| 对照 | adapter结果 | 有完整原始事件证据 |
|---|---|---|
| 原样重放3次（改进采集器后） | 3次正文为空 | 3次均确认正文为空 |
| 只移除文档中的伪指令，重放3次 | 3次正文为空 | 2次确认；1次采集失败，不作为原始事件证据 |
| 增加一句请求交付确认，1次 | 返回37字符正文 | 用于诊断，不计入原题通过率 |

原始事件中出现 `response.output_text.done`，text长度为0；message完成事件的output_text同样为空；终止状态为completed。没有正文增量，也未出现拒绝内容事件。因此，对这些已捕获样本，空白来自当前接口响应链路，不能归咎于本地解析漏字。无法从公开响应确定服务内部为何选择空完成。

初版采集器另做3次原样重放，均解析为空，其中2次留有完整事件摘要；这些记录保留，但不与后续控制组混成新的独立场景。

增加交付确认的对照改变了输入，只说明该请求下模型能返回正文，不是对原题的修复，也不证明把这句话加进全局提示词即可稳定解决。删除伪指令对照没有改善，不支持“单纯是文档伪指令导致”的结论。

## 运行时与 benchmark 的差别

- ChatGPT 的complete路径内部读取SSE后汇总，允许completed且无assistant内容。
- 正式 `AgentLoop` 对空content、end_turn请求原样重试一次，不添加伪造的用户或助手消息；仍为空则按现有规则结束。memory nudge 的空结果另有正常结束语义。
- 之前的 benchmark 直接使用adapter返回，未包含上述重试。它测到的交付失败是真实的当前测试链路现象，但不能当成完整ZeRo运行时的失败率。

对应实现：`packages/model/src/adapters/openai-resp.ts`、`openai-resp-chatgpt-events.ts`，以及 `packages/core/src/agent/agent-loop.ts`、`agent-hooks.ts`。既有测试明确允许空completed，并验证一次重试和持续空回复后的结束；本轮相关3项运行时测试通过。

生产解析器对仅完成事件中的非空正文、拒绝内容的覆盖也值得单独审查，但本次已捕获的原始内容就是空的，不能将那类潜在问题称为这里的根因。

## 一次重试复测

benchmark新增 `--empty-retries 0|1`，默认0保持原测试模式，1单独模拟同请求重试。每轮记录 `emptyResponses`、`emptyRetries`、`emptyRecovered`，所有请求用量计入总成本；持续空回复仍不通过。该模式仍不等于完整Agent闭环。

三个模型、新旧版本、同一伪指令题，各重复3次，共18次：

| 模型 | 完整交付旧→新 | 旧版空次数/重试/恢复 | 新版空次数/重试/恢复 |
|---|---:|---:|---:|
| GPT-5.5 | 2/3 → 3/3 | 2/1/0 | 0/0/0 |
| GPT-5.6 Sol | 1/3 → 0/3 | 5/3/1 | 6/3/0 |
| GPT-6 Astra | 3/3 → 3/3 | 0/0/0 | 0/0/0 |

18次均完成，无接口错误/超时。一次重试只恢复1个Sol旧版样本，未解决持续空回复；Sol新版在本场景仍需保留为失败，不能以早先基础题满分批准所有提示词变化。这仍只是单一场景，不是模型综合排名或统计显著性证据。

后续若要修复产品体验，应针对持续空回复设计可见的未完成状态或有证据的交付回执，并保留合法memory nudge/后台暂停语义；不能全局禁止所有空结果，也不能在benchmark里生成“已完成”来掩盖模型未回复。本轮用户要求先定位，故未改生产收尾行为。

## 参数口径修正

进一步核对请求构造发现：ChatGPT路径目前没有发送max_output_tokens。历史manifest中的maxTokens=2048是调用方请求值，不能当作服务端实际生效上限；maxSteps和worker总时限才由benchmark强制限制。此差异在同模型新旧比较中一致，不改写历史数据，但后续成本解读须注明。

## 可复核产物

- 事件诊断：`.zero/benchmarks/prompt-bench/empty-original-20260906/`、`empty-clean-control-20260906/`、`empty-receipt-control-20260906/`。
- 初版诊断：`.zero/benchmarks/prompt-bench/empty-diagnostic-sol-20260905/`。
- 一次重试复测：`.zero/benchmarks/prompt-bench/empty-recovery-check-20260906/`，含完整计划、轨迹、报告与完成记录。
- 重放工具：`benchmarks/zero-runtime/src/prompt-bench/diagnose-empty.ts`。可用模式为original、clean-document、request-receipt；后两者是对照实验，不可混入原题评分。

新增采集脱敏、同请求重试、预算与持续空回复测试；benchmark共30项离线测试通过，运行时空回复相关3项测试通过。真实任务提取结果见[候选清单](real-task-selection-20260906.md)。
