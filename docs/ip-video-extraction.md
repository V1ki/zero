# IP 视频真实小说提取

本功能只使用 `http://172.18.8.200:8000/v1`、`Qwen/Qwen3.8-27B`，不使用 key，明确设置 `chat_template_kwargs.enable_thinking=false`。配置是此功能内的固定常量，不经过 Zero 全局模型路由，也不修改全局配置。

## 启动与访问

独立 Hono/Bun 后端与 Zero 业务进程隔离：

```bash
bun run /Users/v1ki/Desktop/test4_zero/apps/web/src/ip-video/server.ts
```

它仅绑定 `127.0.0.1:14433`。Vite 已新增优先代理 `/api/ip-video` 到该地址，既有 `/api`、`/ws` 规则保持原样。网页仍使用 `http://127.0.0.1:14432/ip-video`。

**已在主执行环境确认14432为现有Vite服务，独立14433后端已启动，14432代理health及全书245部分逐字网络验证通过。** 早期Codex子环境EPERM不代表主环境网络阻塞。不应为此重启Zero。仅当14432未运行且确认端口空闲时，使用：

```bash
cd /Users/v1ki/Desktop/test4_zero/apps/web
bun run dev --host 127.0.0.1 --port 14432 --strictPort
```

如现有 14432 是静态 Zero Web 服务，这条 Vite 代理不能自动作用于它；需要在允许调整该 Web 服务的环境中确定接入方式，不能直接宣称已接通。不要停止占用端口的其他业务。

页面默认进入真实分析：导入 UTF-8 TXT/MD，选择“开始全书分析”。导入只保存原文，分析才发送到模型。磁盘既有项目自动列出；运行中展示 SSE 进度；失败或中断后选择“继续 / 重试失败”。可切换章节全文、全书资产、当前章节的请求记录；引用可跳转到所在章。独立演示必须主动进入，预置资产与模拟视频任务不会混入真实数据。

## 真实工作台界面

默认真实模式沿用原工作台的品牌、侧边导航、项目总览、资料库双栏阅读、资产类型卡片和详情布局。总览展示已保存项目与真实分块进度；资产库支持类型/名称/别名筛选、每页 12 项、详情中的首条描述节选、别名、折叠完整描述和原文证据。证据按后端 UTF-16 偏移跳转并高亮，章节全文保留原始换行。

页面通过 GET 获取初始项目快照，通过 SSE 接收后续变化。SSE 断开保留已读结果并显示提示，可手动刷新；切章取消旧请求，章节读取失败可单独重试。提取记录保留逐块请求错误，并单独显示身份复核状态；原文覆盖率 100% 不等于身份复核完成。资产直接使用后端 canonical ID、redirects 和完整引用，前端不再次归并或改写持久化数据。

参考图、分镜编排/绑定、视频生成和版本锁定尚未接入真实模式，相关入口禁用并明确标记。卡片图形是标注过的类型图标，不是生成结果。预置资产和模拟任务只在主动进入“独立演示”后出现。界面整合验证与浏览器验收边界见 `shared/ip-video-ui-integration-report.md`。

## 可重复全书验收

```bash
bun run /Users/v1ki/Desktop/test4_zero/apps/web/src/ip-video/acceptance.ts
bun run /Users/v1ki/Desktop/test4_zero/apps/web/src/ip-video/verify-http.ts
```

默认小说：`.zero/workspace/shared/从骑奴到大乾武圣_第1-244章_去重版.txt`。脚本要求实际章号连续为 1–244，校验每个区间连续、分块重组与全文完全一致，然后执行全部待处理分块。退出码 0 才是实际全部成功；退出码 2 表示模型任务失败或受阻。`--offline` 仅核验分章与覆盖，不能作为 AI 完成证据。

重跑复用同原文 SHA256、模型、prompt 内容/版本及块长形成的项目 ID；跳过已成功分块，继续 pending，并显式重试 failed。进度以标准输出事件提供，可通过执行工具的后台完成事件等待，不需进程或日志轮询。

## 数据与执行契约

- 数据目录：`.zero/workspace/shared/ip-video-qwen8000/<projectId>/`。
- `source.txt` 保留完整原文；`prompt.txt` 保留原始 system prompt；`project.json` 原子替换，保存章节、块范围、逐块状态、模型标识、版本、请求历史、usage、错误、资产与证据。
- `attempts/<UUID>.json` 在发送前保存完整请求，完成后保存原始响应、HTTP 状态、响应 model、usage 和校验错误。中断后项目内的 attempt 标记 interrupted；若请求已发送但响应未持久化，计费未知，重试可能重复消耗。
- 每块至多 2400 UTF-16 单位，优先在换行处分割，不裁切代理对；卷首资料也是独立部分。输入全覆盖不等于模型语义提取无遗漏。
- 默认并发 6，可选 4–8；每次执行每失败块最多尝试 3 次；请求含响应正文读取超时 120 秒；重试间隔 1、2 秒。模型预检超时 15 秒，失败则整个任务 blocked，未发送块仍为 pending。
- 严格解析 JSON，要求正常 stop、response model 精确匹配。引用须是当前分块中 10–160 UTF-16 单位的连续原文，名称和所有别名必须出现于该引用中。`ValidationError.issues` 汇总本轮所有错误资产的数组下标（从0起）、完整资产对象及失败原因；引用错误区分长度（含实际长度）、quote不存在于当前分块、name不在quote、哪些aliases未在同一个quote。字段格式错误也附资产对象；错误消息包含这些详情并持久化到attempt。任何资产失败都会拒绝整块结果，不丢弃错误资产后把合法子集记为成功。
- `temperature=0` 保持不变，但每次重试都会重建消息：原始system prompt、当前分块与纠错规则、最近一次模型回答（若有）、该次错误与纠正要求。要求重新对照原文修正全部资产，返回完整`assets`，保留正确项，不允许只返回补丁或删除错误项绕过校验；别名不满足同quote逐字出现时留空`[]`，不得造引用。模型语义遗漏仍不属于字面引用校验可证明的范围。
- 继续/手动重试的首请求从该chunk历史最后一条带错误的attempt读取错误与原始回答；兼容没有纠错元数据的旧attempt。缺少回答时仍反馈错误；当前轮若网络失败，则下一轮只携带该次错误，不混用更早回答。每次仅保留最近1轮回答和错误，不复制前轮request或递归嵌套完整HTTP response；磁盘attempt历史仍完整保留。
- quote 记录全书 `[start,end)`、chapterId、chunkId、章内 offset，单位均为 JavaScript UTF-16。相同引文重复出现时采用块内首次精确匹配。
- 资产先按同类型、NFKC/去空白/小写后的精确同名聚合，ID 沿用其 SHA256 前 24 位。保留旧人物确认及保守别名规则作为基础，人物/场景/道具再通过下述 AI 身份消歧。原始 mentions 和请求响应保持不变；v2 在消歧基础层将未人工确认的通用人物称谓拆为按原始引用定位的局部实体；专名同名异人仍需保持未决，原始 mentions 不改写。
- 进程级项目锁阻止多进程重复执行；无锁时启动服务取得排他锁后恢复 running 块为 pending，并标记项目 interrupted 等待明确继续，不自动调用模型。已有遗留锁不自动删除，须核对所有者后处理；live lock 下恢复不写入。进程存活检查使用信号 0（不发送终止信号）；PID 被复用时保守拒绝，需要人工核对锁。
- SSE 推送由当前后端启动的任务变化，重连时读取磁盘完整状态。独立 CLI 的标准输出提供进度事件；若网页与 CLI 同时打开，CLI 完成后刷新网页读取结果，跨进程实时推送不在当前实现内。当前沙箱的文件监视器也未能可靠工作，因此没有引入未经验证的文件监视或后台状态轮询。

## 通用 AI 身份消歧（ai-entity-v2）

抽取请求的 `identityContext` 提供同项目已持久化资产的 canonical ID、类型、名称、别名、最多两条描述和原文证据。它只是候选线索，不替代本分块原文。原始 system prompt、项目 ID、提取输出 `assets` 和逐字引用校验保持兼容；结构化身份决策由随后独立的 AI 阶段返回，身份错误不会覆盖成功的原始抽取。

当本轮分块处理结束时，自动对存在同类型候选的资产运行跨章消歧。候选从全部成功分块重建，三类资产使用相同流程，没有名称配对表或人名专用白名单。并发抽取未能看到的后续实名也进入候选。每个 subject 的全部已提取引用分成每页最多 8 条，普通主体每条附同章前后最多 500 UTF-16 单位，局部人物最多 1800。候选保留同类型完整目录、语义描述和原始证据，不按名称相似度排除异名。另提供相邻章节（每章最多 3500）、全书叙事检索片段（最多16段）和按描述/原文相关度选出的24个候选引用周边。检索使用中文2–4字片段、逆文档频率及通用回指/揭名词，只负责召回原文，不据此自动判断同人；retrieval.complete=false 明示证据窗口有限。候选超过 400 时显式标记目录不完整，禁止 match；有限候选证据无法充分证明身份时返回未决。

模型返回 `outcome=match|new|unresolved`、`canonicalId`、`candidateIds`、`reason`、`evidence[{contextId,quote}]`。match 只能引用请求白名单中的唯一同项目同类型 ID；new 表示独立实体或自身应保留为 canonical，不能生成任意 ID。任何结果必须有原文证据。match 的证据必须覆盖本页每一条原始 quote 的确切位置，且含目标名称的来源证据；新增身份引用须为已提供上下文内连续 10–400 UTF-16 单位原文，offset 由代码计算。身份审计证据不追加到资产引用统计中，提取引用继续遵守原有 10–160 限制。

匹配提案还会独立发送第二次 Qwen 复核，要求排除竞争者、检查称谓所属/叙事延续、否定/冒称、地点与其子区域等。只有复核同意且全部页指向同一个 canonical 才归并。多候选、不充分证据、跨页不同归属、复核分歧、链/环及人工确认边界保持未决。通用称谓没有一律忽略或一律合并的规则。逐字校验保证证据来源，不能单独证明语义蕴含；两次同模型判断也不是独立真值。

`identityResolution.ai` 保存快照、对象范围、逐页提案/复核尝试、结果和状态；`aiHistory` 保留历史运行。请求范围独立，指定一个对象不会自动续跑旧的整库失败范围；journal 按快照和对象范围隔离。原始请求、响应、HTTP 状态、模型返回值和 usage 在独立 `entity-attempts/` 中，含 prompt hash 和完整 request hash。成功页按请求内容 key 缓存，失败/中断页重试（每次最多 3 次，含响应体 120 秒超时）；已提交相同范围再次执行无请求/无文件改写。单个subject耗尽模型重试后写入`failures`并继续其余subject；存在任一失败时整轮及项目保持`failed`，不会标记`completed`。存储、原文完整性等非模型错误仍终止任务。未收到并持久化的响应无法保证模型侧恰好一次计费。

新增成功分块会改变请求快照，但不撤销已复核的归并。`commits` 单独保存已确认的来源引用键、目标引用键、原文hash及身份证据；重建/恢复/重试只应用已审查范围。旧v1完整成功运行（包括被标为stale的历史）可经逐页复核记录和原文覆盖核验恢复；失败运行的局部提案不得升级为确认。对于已经形成match决策且每一页提案和独立复核均成功的subject，在旧快照仍有效时重新执行原文、候选白名单和逐页证据校验，生成范围明确的确认checkpoint；补跑chunk前持久保存该确认，避免新快照丢失已验证归并。未变快照复用成功页；快照改变时原成功决策保留在历史审计，new/unresolved需结合新候选重新评估，已确认match只沿用原已覆盖引用，新mention仍须审查。冲突写入`conflicts`，迁移拒绝提交；新目标冲突不能静默替换先前确认。

通用称谓按mention使用稳定局部ID，`mentionRedirects`记录逐引用归属。“女子/女刺客/老人”等不注册为实名人物的全书别名，新增同名mention不会继承旧匹配；旧名称桶ID仅在其全部mention归属唯一时兼容，否则返回404而非猜测一个人。其他原始名称、别名声明、描述和证据仍可从不可变mentions及审计追溯。迁移按逐引用目的身份核验守恒。拆开旧同名桶会使资产数量增加，数量减少不是消歧成功标准。旧人物人工确认持续保留；本版本不让AI自动扩散到人工确认组。

恢复既有库的实际结果及主环境精确操作见 `.zero/workspace/shared/ip-video-anonymous-resolution-report.md`。只读代码重建不是现库修复证据。

现有库仅做小范围消歧，不调用章节提取：

```bash
# 使用现有 canonical ID 指定需要复核的对象；候选自动包含同项目同类型其他资产。
bun run apps/web/src/ip-video/resolve-entities.ts <projectId> <canonicalId,canonicalId>
# 应用前先完整备份、核对 SHA256；同一个 run.lock 阻止与提取并发。
bun run apps/web/src/ip-video/resolve-entities.ts <projectId> <canonicalId,canonicalId> --apply
# 受控原文的小范围真实 Qwen 消歧验收；不是全书重跑，也不是提取召回率测试。
bun run apps/web/src/ip-video/entity-acceptance.ts
bun run apps/web/src/ip-video/anonymous-acceptance.ts
```

迁移默认只做 AI 预览；`--apply` 在调用模型前完整备份至 `shared/ip-video-entity-backups/`，原库直到所有请求校验完成及引用守恒检查通过才原子替换。断点 journal、候选和请求记录在 `workspace/zero-feishu/ip-video-entity-resolution/`；失败保留备份和日志，不修改原库。相同快照续跑复用成功页和已有有效备份。已有库不因服务启动自动调用消歧；新增提取任务自动运行上述阶段，消歧失败可继续且成功块不重提取。大项目会产生额外逐实体/逐页请求，不应用全书分析入口来验收个别重复名称。

API 沿用 GET 项目/旧 ID 查询及 analyze/SSE，身份审计随项目返回；未增加可提交任意模型 ID 的写接口。独立 14433 后端需要由主会话重载新版代码，不能重启 Zero 或改全局模型配置。在线状态及本次真实验收阻塞见 `shared/ip-video-entity-resolution-report.md`，旧验收报告不代表本版已上线。

## 旧跨章人物别名与迁移（兼容层）

`character-alias-v1` 从全部成功分块的原始 mentions 重建资料库，不依赖分块完成顺序。自动归并须同时满足：模型明确列出别名、别名已作为独立人物出现、全书仅一个候选归属、原 quote 中两端名称以“又名/本名/真名/原名/化名/别名/也就是/人称/即是”紧邻连接且有标点边界。疑问、常见否定或不确定表述不通过；仅同句出现、描述相似、别名交集不构成自动同人依据。称谓后缀（包括二爷、夫人、泽二爷、李夫人等）、链、环、多候选全部保留独立人物。规则有意保守，并非通用自然语言语义证明。

项目增加可选 `identityResolution`：版本、`confirmations`（fromId、canonicalId、confirmedBy、confirmedAt、reason）、`redirects` 和逐条 `decisions`（候选、结果、理由、完整来源 evidence）。人工确认可以解决称谓，但必须指向现有两个人物，禁止冲突、链和环；与人工已确认成员相连的其他关系不自动扩散。具体人物关系只放在项目确认数据中，不硬编码到算法。

保留归属人物既有 canonical ID；早期独立别名的旧 ID 通过 `redirects` 和 `resolveAssetId` 兼容。新增 GET `/projects/:id/assets/:assetId` 接受 canonical ID 或旧 ID，返回统一资产（不存在则 404）。当前 UI 只以资产 ID 作为 React key，没有其他需要改写的持久化资产外键；引用继续以 chapterId/chunkId/offset 定位。自动归并在后续分块出现多个候选时撤销，不把猜测永久锁死；canonical 人物 ID 不变，歧义别名恢复其原 ID。人工确认持久保存，后续 save/reopen 使用同一确认重建。

资产保留所有名称、去重后的描述和引用。引用仅在 chapterId、chunkId、start、end、chapterOffset、quote 全部一致时去重；相同文本位于不同位置/来源仍分别保留。原始 mentions 不去重不改写，可以回溯每一条模型提取。

离线迁移（不发模型请求）：

```bash
# 确认文件是 IdentityConfirmation 对象数组；默认只预览。
bun run apps/web/src/ip-video/migrate-aliases.ts <projectId> <confirmations.json>
# 显式应用前取得 run.lock，拒绝已有锁/运行状态；先备份再原子替换 project.json。
bun run apps/web/src/ip-video/migrate-aliases.ts <projectId> <confirmations.json> --apply
```

完整项目备份位于数据根目录同级 `ip-video-alias-backups/`，另存逐文件 SHA256 manifest；仅临时 run.lock 不备份。应用前验证原文范围和 offset、备份字节一致、每个目标人物的引用集合守恒及描述/名称不丢失。原始 chunks、attempts、source.txt、prompt.txt、请求响应及旧验收记录均保留；重复应用相同确认不会改写文件或生成重复备份。旧验收报告是历史快照，不应当作迁移后的资产统计。

迁移后既有 GET 项目接口每次读取磁盘，页面刷新可取得新资产，不需要重启 Zero。已经运行的旧独立 14433 Bun 进程仍需重新加载新版代码，才能启用新归并算法和旧 ID 查询接口；加载前不要重新分析，否则旧 save 会重新生成精确同名资产。本次迁移命令不会重启服务或更改系统配置。

## Prompt 追溯与兼容

原始system prompt保持逐字不变：`promptVersion=ip-assets-quote-v1`，UTF-8内容SHA256为`6a2445ca418c05d216882cec90e6e04791ee9abafb16e322f4d15757648b5ddf`。项目ID规则、`prompt.txt`及项目`promptSha256`仍对应这一原始prompt，因此已有项目可继续重试，成功块无需重跑。执行前同时验证版本、代码原始prompt hash、磁盘`prompt.txt` hash，拒绝不一致的配置。

新增纠错指令独立标记为`ip-assets-correction-v1`，不冒充原始prompt版本。每个新attempt记录原始`promptVersion/promptSha256`、`correctionPromptVersion/correctionPromptSha256`，以及`requestSha256`（实际完整请求经`JSON.stringify(request)`后的UTF-8 SHA256）。纠错指令放在请求user消息的`instructions`中；动态错误和最近回答可从保存的messages核对。旧attempt不补写新版本标签，不重算旧报告统计；完整请求hash与原始system prompt hash用途不同，不可互换。

## API

所有接口前缀 `/api/ip-video`：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 固定端点、模型、prompt/实体版本、数据根目录及PID |
| GET / POST | `/projects` | 项目列表 / `{title,source}` 导入 |
| GET | `/projects/:id` | 状态、逐章/逐块进度、资产 |
| GET | `/projects/:id/assets/:assetId` | canonical 或旧 ID 查询同一资产 |
| GET | `/projects/:id/source` | 完整原文 |
| GET | `/projects/:id/chapters/:chapterId` | 章节全文 |
| POST | `/projects/:id/analyze` | `{retryFailed:true,concurrency:6}` |
| GET | `/projects/:id/events` | SSE 持久化状态变化 |

无任意文件路径导入接口、无全局模型修改接口。服务仅供本机使用，写入请求限制来源；如需多人共享，需先补充身份权限设计。

## 验证边界

`__tests__` 中模型传输均为明确 fixture，验证处理逻辑，不代表真实 Qwen 提取质量。`verify-http.ts` 对全书所有章节执行 Hono 内存 HTTP 请求，证明接口无截断，不等同真实 14432 网络或浏览器验收。实际结果以 shared 下 `ip-video-qwen8000-acceptance.md` 及对应 `acceptance.json` 为准。

纠错回归使用隔离临时目录和fixture传输，覆盖多资产错误汇总、合法子集拒绝、反馈后完整结果修正、仅最近一轮上下文、旧项目重开后的首请求反馈、网络错误及prompt追溯。可运行`bun test apps/web/src/ip-video/__tests__`和`bun run check`；这些命令不会启动全书提取或更新验收报告。本次修复的真实模型效果由主环境后续执行确认。

## 2026-09-17 独立全书续跑

主环境脚本：`.zero/workspace/zero-feishu/full-rerun-resume.ts`。加`--check`只做本地预检；无参数才调用模型。数据固定为`shared/ip-video-full-rerun-2026-09-17T05-46-26-022Z/data`中的项目`ab84df8bcb29024ca54996f9`，不经过线上API。先在独占锁内完整备份独立目录并校验SHA256，再仅重试第4、116、172章的失败chunk及继续身份审查；所有已成功chunk禁止发送请求。日志只输出计数，结果写入该独立目录的`resume-summary.json`，失败返回非零退出码。已有锁不会自动删除。详细诊断及离线验证见`.zero/workspace/shared/ip-video-full-rerun-diagnosis.md`。

## 2026-09-18 有预算的局部修复

已有全书实测数据的后续修复使用 `.zero/workspace/zero-feishu/full-rerun-targeted.ts`，默认/`--check`只读，主环境`--apply`才联网；完整备份、排他锁、快照指纹与逐文件保留检查后执行固定1个失败chunk和显式subject白名单。最多80个网络请求（含探测、重试、隔离复核）。不要再用旧`full-rerun-resume.ts`或全书analyze入口处理这批个别失败，它们仍可能进入全量身份审查。

`ProjectStore.start`新增仅供内部调用的`targeted:{chunkIds,subjectIds,expectedProjectSha256?}`；取得锁后核对备份指纹，拒绝未知范围，提取前完整归档旧身份run，chunk改变snapshot也不扩大身份请求范围。保留原成功结果和审计，局部执行不能把项目标记为全书完成。范围外新实体列为延后审查，不自动调用模型。

抽取新增`quote-id-v1`及纠错v2：输入`quoteOptions`由原文连续窗口生成，返回资产可用`quoteId`替代quote。身份审查新增`entity-evidence-id-v1`：可用`evidence:[{evidenceId}]`选择当前页已提供的原始证据。展开只按白名单精确定位，不自动修饰原文、纠正ID、补齐目标证据或推断身份。旧quote格式、长度/名称/别名/页覆盖/同类型/独立复核等校验保持。类级货币归类不等于剧情实物身份合并。

原始SYSTEM_PROMPT、prompt.txt、项目ID仍兼容；实际发送system prompt追加显式证据协议，trace分别记录原始与实际system hash、协议hash和完整request hash。旧审计不补写。完整实测根因、3项尚未修复的语义质量问题、主环境验收边界见`.zero/workspace/shared/ip-video-targeted-repair.md`。离线测试通过不能替代独立库质量验收。

### 来源审查更正层（qualityCorrections）

成功 chunk 的 raw mentions 与 HTTP 审计保持原样。`Project.qualityCorrections` 是追加记录的哈希链，每条携带 source SHA256、reviewer、时间、理由、精确原文证据及 `source-review` 来源。当前支持撤回错误 commit、补充局部 mention、按 evidenceKey 更正类型、局部分离/绑定、明确不同实体约束及创作目录类别分组。来源审查记录不是模型输出。更正提交前校验 source 与范围；保存和重建保留旧决策与 commit。

撤回既屏蔽原 commit，也阻止从历史 completed run 换一个局部 ID 再恢复同一错误匹配。局部绑定只转移指明的 evidenceKey，不创建全书通用别名。不同实体约束在模型 verdict 校验及最终 commit 应用时都生效。旧 ID 含多个人时，`GET /projects/:id/assets/:assetId` 返回 409 和 destinations；加 `?evidenceKey=<URL编码的原始evidenceKey>` 精确查询原引用，不随机跳到其中一人。唯一类型更正仍保留旧 ID 重定向。

`categoryGroups` 仅是创作目录投影：一张类别卡可展开成员描述与来源；成员实物身份、ID、事件及原引用不变。不得用分类代替 identity match。

`entity-evidence-id-v2` 在发送请求前为 narrative/neighbor 上下文生成明确 window 选项；`original` 只存在于确有 originalQuote 的上下文。模型必须复制提供的 ID，不能从 contextId 猜出 ID。原有 10–400 UTF-16 长度、逐字原文、白名单、目标来源、全页覆盖、同类型和独立复核限制保留。旧无效响应仍拒绝，不根据回答补造选项。来源补充的揭名证据也进入局部 frame。

本次独立全书库操作的固定范围、备份锁和最多20次调用脚本，见 `shared/ip-video-quality-corrections.md`；默认 dry-run，不通过普通 analyze 入口进行全书重跑。
