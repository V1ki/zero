# 系统提示词冻结样本

- `before-20260905.json`：从提交 `020ab63e950db3fce308c742cc0bc566f7f12708` 的源码构造，代表本次修改前的提示词。
- `after-20260905.json`：从本次已调整的工作区源码构造。
- `advanced-before-20260905.json`、`advanced-after-20260905.json`：同一对源码用于进阶题库的快照。进阶集不包含独立收尾题。

两份快照使用同一套模拟工具、固定路径、空身份偏好、无技能目录，以及各自版本的默认 bootstrap 模板。
因此测量的是主提示词与默认 SOUL 的组合变化，以及独立的收尾判定变化；不包含个人记忆、真实工作区文件、在线技能或其他 Codex 指令。

快照保存渲染后的 full/minimal 系统提示词、每个收尾样本的输入、源码哈希和场景集哈希。
修改快照会使校验失败。请通过 `bun run prompt:bench snapshot` 生成新文件，不手动编辑 JSON。

原始 basic 快照不受进阶题库扩展影响。不同 suite 不允许交叉比较；场景哈希按各自题库计算。

历史源码的渲染只从临时目录加载构造器及其直接依赖，不切换当前分支或覆盖工作区。
shared token helper 使用当前 benchmark 依赖并记录哈希；比较保留下来的渲染文本时，不再执行历史源码。

完整使用方式见 `docs/prompt-benchmark.md`。

`real-tasks.json` 是从 ZeRo `.zero/logs/sessions.db` 提取的14个任务片段及验收契约，包含4个简单、6个中等、4个困难案例。此前 Codex 来源已移出。该文件是完整任务选题清单；其中部分已裁成可运行子题，记录在 replay 字段。游戏纠正题已进入开发/校准样本，剩余3个留出候选未运行。

`real-replay-v1.manifest.json` 指向本地冻结的真实素材，并验证 SHA256。`--suite real` 含4个执行子题及2个收尾诊断；正文素材在 `.zero` 中，不加入源码。`real-before-20260906.json` / `real-after-20260906.json` 为本轮新旧快照。运行结果及限制见 `docs/prompt-benchmark-real-20260906.md`。

`evaluation-rubrics-v1.json` 为14个完整任务的75项评分契约；`publication-assessment-template.json` 是可填写的论文到公众号评分卡。填入证据后用 `assessment.ts` 计算，未核验项不会被折算成通过。详见 `docs/benchmark-evaluation-standard.md`。
