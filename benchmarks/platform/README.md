# ZeRo Benchmark Platform v1

统一运行记录、证据引用、成本口径与报告；每种 benchmark 继续定义自己的任务和评判规则。平台位于独立 Bun workspace，不依赖 ZeRo Session、模型供应商、密钥或数据库。现有调用入口不变。

这是本地 TypeScript 插件 SDK + CLI，不是 Codex 插件、Web 服务或完整隔离容器。

## 开始使用

从仓库根目录运行。输出路径必须不存在，历史报告不覆盖。

```sh
bun run bench help

# 只读插件元数据，不执行 setup、任务或评分器；out 是新文件。
bun run bench plan --plugin benchmarks/platform/examples/file-summary.ts --out /tmp/zero-bench-plan.json

# 真正读写独立目录中的文件，包含正确和故意漏算的对照版本；没有模型请求。
bun run bench run --plugin benchmarks/platform/examples/file-summary.ts --out /tmp/zero-bench-run --reps 3

bun run bench compare --input /tmp/zero-bench-run/results.jsonl --baseline known-bad --candidate correct --out /tmp/zero-bench-compare.json

bun run bench:test
```

`plan` 会 import 本地模块，因此插件顶层只能声明元数据，不能读取密钥、启动服务或调用外部工具。插件是可信代码，加载任意模块并不是沙箱操作。

## 接入接口

完整契约在 [types.ts](src/types.ts)，可运行的最小实例在 [file-summary.ts](examples/file-summary.ts)。新插件默认导出 `BenchmarkPlugin`：

| 插件提供 | 内容 |
|---|---|
| 身份 | `apiVersion: 1`、id、实现版本 |
| 任务 | id、任务族、来源组、输入指纹、验收契约指纹 |
| 对照版本 | 版本 id 及提示词/配置指纹 |
| 目标和环境 | 模型/浏览器/其他目标；simulated、controlled、live 或 offline；环境指纹 |
| setup / cleanup | 准备每次运行的独立状态，释放插件自己创建的资源 |
| execute | 使用 Context 工具完成任务；返回 completed / partial / blocked / stopped |
| evaluate | 返回带版本的评分器、逐项检查、证据引用、自定义指标与待评审状态 |

平台负责矩阵、重复、配对块内的可复现运行顺序、每次独立目录、计数预算、调用日志、产物摘要、结果校验和统一报告。默认顺序执行；程序接口 `RunOptions.concurrency` 可设置并发，每次仍使用独立目录。需要共享外部状态的插件必须自行隔离，不能仅靠目录隔离保证安全。

`runBenchmark(plugin, options, hooks)` 支持可插拔执行器。默认直接在当前进程调用 `runTrial`；`createProcessExecutor({ modulePath, config, cwd })` 则为每次试验创建独立 Bun 进程，由同一 `runTrial` 执行 setup/execute/evaluate/cleanup。模块可以导出插件对象，也可以导出接收配置的工厂函数；工厂不能在初始化阶段读取凭据或执行外部操作。

独立进程执行器在父进程实施硬截止，忽略取消的 worker 也会被终止；已完成调用从事件日志恢复，进行中的请求保留次数并将用量记为未知，不清零整项试验。事件追加包含阶段和时间戳。SIGKILL 不保证终止已被远端服务接受的工作，也不会执行被杀进程中的 cleanup；插件仍需考虑远端残留。

`Context.model()`、`Context.tool()` 包裹**真实实现函数**，也可包裹模拟实现；平台不解释或强制工具参数。函数收到 AbortSignal，并返回 `{value, status?, usage?, cost?, actualModel?}`。工具的业务错误可用 `status: 'error'` 返回给执行者恢复；抛出的异常中止本次插件阶段。每次重试需要再次调用包装器，才能计入真实次数。

`Context.artifact(name, content)` 保存显式选择的证据，返回带 SHA-256 的引用。评分项引用这些 evidence ID。`passed` 必须有非空检查项、全部为 true、每项都有证据引用。插件负责检查证据内容的真实性；平台只校验引用、结构与状态，不替代研究评审或视觉审核。现有 14 张真实任务评分卡可以由专用 evaluator 转换成该接口，尚未自动接通独立模型盲评。

不要在调用包装器内部启动不等待的后台工作。所有子任务及异步调用必须在 execute/evaluate 返回前收拢。插件如需子模型调用，应将每次物理请求单独记录为 model，避免在外层再重复登记同一笔 token 或费用。

## 比较契约与非确定性

任务输入、验收范围、实现版本、环境/工具版本、评分器和预算组成 comparisonKey；版本配置指纹另存。默认只有相同任务、目标、环境、比较契约、重复编号和运行块才配对。重复或模糊配对拒绝处理；缺失、异常、待评审和评分器漂移列为 unresolved，不记平局。

- `simulated`：固定返回规则，用于快速行为回归。
- `controlled`：真实文件、代码、浏览器或模型执行，固定材料与初始状态。
- `live`：真实外部服务，每次保存可核验证据，观察结果分布。
- `offline`：无外部执行的静态评估或代理指标。

不同模式不合并排名。参数/工具路线不同不扣分，按产物、授权及任务契约评分。模拟回放如何匹配参数由插件实现；禁止新请求直接套用不相符的旧返回。

插件应在 environment fingerprint 中绑定工具 schema/实现、原始文件、可用授权、依赖版本及模型设置。平台 CLI 的 seed 仅控制运行顺序，并不保证模型、图片或搜索服务的输出可复现。需要工具随机种子时，由插件根据同一任务/rep 为新旧版本显式提供，记录在输入摘要和证据中。

原生运行每次使用独立工作目录，但这并不隔离网络账户或外部服务；真实草稿、浏览器资料目录等必须由插件另行隔离并清理。生产发送或发布必须有任务本身的明确授权。

## 记录与展示

```text
<run>/
  manifest.json              冻结计划、预算和矩阵
  results.jsonl              每次完成后追加，可独立导入/重建报告
  summary.json               分组统计、自定义质量指标、成本及覆盖率
  report.md                  总览、逐任务结果、工具分布和解读边界
  trials/<trial-id>/
    events.jsonl             调用开始/结束、超时、失败阶段、证据摘要
    <explicit-artifacts>     插件选择保存的脱敏证据
```

主任务与收尾分类等不同任务族分开统计；没有跨任务族的万能总分。summary 中提供独立任务数、来源组数、通过/尝试数、异常与待评审数、耗时中位数及范围、各指标的已知/未知样本数。来源组必须由插件正确标注，重复运行不等于新增独立来源。

执行和评审分账。input 是未缓存输入；cacheRead/cacheWrite 独立；reasoning 是输出的说明性子集，不额外累加。供应商口径不同必须先归一化，未知字段用 null。工具次数不等于模型请求数，并行工具时长之和不等于任务墙钟时间。

费用必须带币种、billed/estimated/declared-free 依据；估算需附 rateCard 标识。未提供费用不能当免费；已知小计与未知调用数同时显示。不同币种和估算/实际费用不合并。当前没有自动价格抓取、换汇、美元硬预算或账单对账。

失败和重试进入总成本与分母；单次请求失败且无法获知用量时，该次总量保持未知，已完成请求的用量仍在 operations 中。不能只展示成功样本均值。比较文件同时保留通过状态变化和同对均通过的效率差；“均通过”只代表同一验收门槛，不能证明开放质量相等。是否采用新版仍应按任务族质量、关键失败与成本复核，不自动发布提示词。

默认日志只存参数和结果的 hash/字节数，不存正文；敏感的参数、完整模型输出及异常原文不会自动复制到报告。需要内容审阅时，插件显式保存经过筛选/脱敏的产物。哈希本身不能证明内容正确，人工/模型评审仍需访问对应证据。平台也无法替插件辨识任意自由文本里的所有秘密。

中断可能留下未结束的 events 和不完整 results。manifest 中的计划数可用于核对，`report` 仅统计已落盘结果，不能声称未落盘任务已执行完。首版不自动恢复、重试整项任务或清理生产资源。

## 旧 benchmark 迁移

两类已有入口在原输出的 `platform/` 子目录提供统一记录，接入深度如下：

| 现有 benchmark | 接入状态 |
|---|---|
| prompt:bench | 已原生接入：平台调度和独立进程执行；Context 逐次记录模型/工具；evaluate 执行原机械评分；兼容报告由原生结果生成 |
| zero-runtime Session | 已自动导出；保留原有机械验证范围 |
| task-closure:prompt-bench、tool-io-digest | 下一批适配，原入口继续可用 |
| compaction:harness-eval | 下一批适配，需保留代理指标口径 |
| browser-comparison、x-search-usage-probe | 下一批适配，目标不强制是 LLM |
| log-storage-audit、trace2skill-miner | 审计/提取工具，仅在需要对照评估时接入 |

历史文件可独立导入，无模型请求、无原始 session 修改：

```sh
bun run bench import --format prompt --input /path/results.jsonl --out /path/new-import
bun run bench import --format runtime --input /path/summary.json --out /path/new-import
bun run bench import --format compaction --input /path/summary.json --out /path/new-import  # 已退役的 compaction:prompt-bench 的旧结果
bun run bench report --input /path/results.jsonl --out /path/new-report
```

适配器见 [legacy.ts](src/adapters/legacy.ts)。它是旧结果字段翻译，不是重新执行或重评分。源文件内容只读一次并计算 SHA-256；无法确认的输入状态用整批文件指纹约束，保守地只允许批次内比较。缓存/逐步耗时缺失不补造，超时占位的零用量转换为未知。压缩的 parse 成功仅作为检查，保留 compact/handle/future-arg 等指标并标记语义待评。

新 benchmark 优先直接实现 Plugin；旧 benchmark 可以先加结果 adapter，再逐渐将实际调用放进 Context 包装器。无需先重写 Session 或迁移所有旧脚本。prompt 原生工厂见 [platform-plugin.ts](../zero-runtime/src/prompt-bench/platform-plugin.ts)，继续通过 `bun run prompt:bench` 提供快照、模型、题库等参数。历史结果导入仍保留，但不再用于新 prompt 运行的接入路径。

## 首版限制

没有 Web 看板、通用录制回放引擎、远程 worker、容器沙箱、自动双模型盲评或自动上线决策。默认的当前进程执行器仍使用协作取消，插件忽略取消可能挂起；需要硬超时应选择独立进程执行器，prompt benchmark 已这样接入。进程隔离不是文件或网络权限沙箱。max-model-calls 和 max-tool-calls 是可强制执行的包装器计数预算；绕过包装器的调用不可见。

这些能力可在稳定的记录与插件契约上继续实现；首版不拿接口声明当作已实现能力。
