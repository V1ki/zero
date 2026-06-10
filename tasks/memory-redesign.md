# 记忆系统重构 · 设计文档（逐条评审）

> 状态：讨论稿，未拍板。本文档供逐条过审。
> 标记法：**【结论】**=讨论中已达成；**【决策】**=需要你拍板（文末第 9 节汇总）；**【坑】**=必须正视的风险/降级点。
> 范围：本轮聚焦"记忆怎么不重复 + /memory 页面怎么改"。冲突裁决的完整优先级模型只做到够用，留作后续。

---

## 1. 问题框架：四柱模型

把记忆系统拆成四件事，是后续一切设计的统一视角：

- **1.1 怎么写** — 何时写、写什么粒度、写多少。
- **1.2 怎么读** — 给定 query 返回哪些、怎么排序、怎么去冗余。
- **1.3 记忆之间的关联** — 节点之间有哪些（带类型的）边。
- **1.4 记忆的发展** — 一个事实如何被修正/取代/归并/淘汰。

**【结论 1.5】** 写/读是两个 I/O 边界；关联（结构）+ 发展（时间）是中间的内部模型。一条记忆=节点，关联=边，发展=节点与边随时间变化。**现系统只有写和读、且都是节点级；关联与发展几乎不存在 —— 这是膨胀的根因。**

---

## 2. 诊断（为什么要改）— 实测依据

- **2.1【结论】节点袋子**：`related:[]` 几乎全空；`packages/memory/src/lifecycle.ts` 的 `verify/archiveOld/resolveConflict` 写好了但**生产代码从不调用**。系统只增不减。
- **2.2【结论】重复规模**：全库 1786 条；语义聚类 `cos≥0.90` 得 **148 簇 / 468 条（26%）** 近重复。
- **2.3【结论】重复词法查不出**：近重复正文 5-gram Jaccard 仅 0.06~0.20、标题各异。**只能靠语义向量**（`.zero/memory/vectors/index.json`，1024 维含 norm，已覆盖全库）。
- **2.4【结论】主导模式 = 会话内快照爆发**：单会话单主题最多写了 **24 条**（ComfyUI 部署，2.5h 内每 ~6 分钟一条）。次因 = 跨会话重新推导（如 B 站转录 13 条 / 6 会话）。
- **2.5【结论】提示词软去重无效**：`prompt.ts:193`「先 `memory_search`、同主题优先 `update`」于 **2026-03-25** 上线、03-27 精修；但上线后重复率仍 **24~31%**（4 月 31% / 5 月 24%），曲线没下行。结论：**写入去重不能只靠提示词，是架构问题**。
- **2.6【坑】lifecycle / vectorIndex 没接线**：`MemoryLifecycle` 从未实例化、不在 `ZeroOS` 接口上（`main.ts` 只挂了 store/retriever/memo）；`vectorIndex` 是 `setupMemory` 的局部变量、关 embedding 时为 `undefined`。**所谓"激活已有能力"第一步是把它们接到 ZeroOS，不是加一行路由。**（以上 file:line 由子代理推导，落地前需复核。）

---

## 3. 设计原则（贯穿四柱）

- **3.1【结论】检测与裁决分离**：「是不是同一件事」（语义召回/聚类）和「谁该赢/怎么并」（优先级裁决）是两件事，别用一个相似度阈值同时回答。
- **3.2【结论】同步薄、异步厚**：确定性的廉价判定（精确重复 hash / 同任务路由）同步做；语义近重复的裁决与合并走异步——因为**合并本质是回溯的、集合级的**（要拿到整簇才知道留哪条）。
- **3.3【结论】默认保留、可逆、可回看**：高相似配对里**互补是多数**，误合并=永久丢信息。所以默认折叠而非合并、归档而非删除、动作可预览可撤销。
- **3.4【结论】裁决信号口径**：`source`（用户陈述 > 实测/runbook > session > 模型推断）是这库唯一干净的强信号；**被污染的 `updatedAt`/`confidence` 退出主链**（updatedAt 被 2026-06 人工去重批次 touch 成反向信号；confidence ~99% 恒为 0.85，无区分度）。
- **3.5【结论】关系=带类型的边**：`same-as`(纯重复)/`subsumes`(包含)/`same-topic`(互补,共享 topicKey)/`supersedes`(演进)/`contradicts`(冲突)/`derived-from`。**不要把边塞进现有 `related[]`（会和 resolveConflict 推的裸 id 双写污染），应新增并行 `edges` 字段。**
- **3.6【结论】施工顺序**：关联（地基）→ 发展 → 读（折叠，可早做止血）→ 写（粒度，治本最后做）。但 **P0 把"读折叠 + 硬删可逆"前置**，因为它最便宜、不依赖尚不存在的聚类。

---

## 4. /memory 页面目标形态

保留现有两栏 master-detail（零回归基线），新增一个**可选的「簇治理」Tab**。折叠/边/生命周期都"空库零变化、有数据才点亮"。

### 4.1 主界面线框（默认=浏览态，折叠开关默认关）

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Memory                              [ 浏览 ]  [ 簇治理(148) ]  ← Tab切换  │
├──────────────────────────────┬────────────────────────────────────────────┤
│ [🔍 搜索记忆…            ]    │  ┌─ DETAIL ───────────────────────────────┐ │
│ 全部 session incident runbook │  │ [session] ◉verified ●●●●○               │ │
│ decision note inbox pref      │  │       [Verify][Archive][Supersede…][冲突]│ │ ← 生命周期动作组
│ [全部状态▾] [最新▾]           │  │                                         │ │   (替换原硬删)
│ [▢ 按主题折叠]  ← 新,默认关   │  │ 标题  #tag #tag                         │ │
│ ───────────────────────────  │  │ ──── 正文 ────                          │ │
│ ┌折叠关:今日扁平列表────────┐ │  │ …                                        │ │
│ │[session] ●●●●○  3h         │ │  │ ── 关联与主题 ──────────────────────    │ │ ← 详情底部连边区
│ │ 标题截断…  ⊂同主题 ⇡演进自 │ │  │  ⊂ 同主题 → 另一条                  ↗   │ │
│ └──────────────────────────┘ │  │  ⇡ 演进自 → 旧快照                  ↗   │ │
│ ┌折叠开:簇卡片─────────────┐ │  │  ⚡ 冲突于 → 矛盾记录                ↗   │ │
│ │[note] ●●●●● 主题封面       │ │  │  [+ 查看近邻 / 建立关系]  ← 向量近邻      │ │
│ │ 权威条标题…                │◀─┘                                          │ │
│ │ ⊟ +5 条侧面 (含1归档,灰显) │ │   (未选中 = MemoryOverview 总数/类型/最近)   │
│ └──────────────────────────┘ │                                              │
└──────────────────────────────┴────────────────────────────────────────────┘
```

### 4.2 「簇治理」Tab（批量止血工位，数据就绪才点亮）

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Memory · 簇治理            [ 浏览 ]  [ 簇治理(148) ]                      │
│  近重复生成率 ▁▂▅▇▅▃   468/1786(26%)落在簇里   [刷新聚类]  ← 写柱看板      │
├──────────────────────────┬────────────────────────────────────────────────┤
│ 待裁决簇(按重复度排序)    │  簇 #C-031  topicKey:dataset-extract  6条 cos.94 │
│ ┌─────────────────────┐  │  建议: ○合并 ○取代 ●共存(默认) ○冲突  ← 偏保留   │
│ │● 同主题 6条 cos.94   │  │  ┌─权威条预览(topic-fold)──────────────────┐  │
│ │ dataset 抽取流程     │  │  │★[session] verified ●●●●○ "抽取流程 v3"  │  │
│ └─────────────────────┘  │  └──────────────────────────────────────────┘  │
│ ┌─────────────────────┐  │  侧面(5条折叠)▾                                  │
│ │○ 同主题 4条 cos.91   │  │  ├[draft]"抽取流程草稿" 边:同主题▾ cos.93        │
│ └─────────────────────┘  │  └…(灰显=已归档,不再露面)                         │
│ [全部接受建议]           │  裁决预览: 5×draft→archived · 1×session→verified  │
│                          │  [确认裁决(归档5·建权威1)] [跳过] [全部共存]      │
└──────────────────────────┴────────────────────────────────────────────────┘
   ConfirmDialog(danger=false): "将归档5条(可还原),不删除任何数据" [确认][取消]
```

### 4.3 四柱在页面的落点

- **4.3.1 读（主题折叠）**：`[▢ 按主题折叠]` 开关 → 同 `topicKey` 收成簇卡片只露权威条，侧面折叠、归档灰显附后。最便宜的止血（24 条 ComfyUI 在 UI 上塌成一条）。复用 `MemoryRetrievalBlock` 的条件渲染骨架，不引图库。
- **4.3.2 关联（带类型的边）**：卡片 `RelationBadgeRow`（同主题/被包含/演进自/冲突于）+ 详情底部 `RelatedTopicsSection`（可点连边，点了 `setSelected` 同页跳转）+ `NeighborPicker`（查近邻人工建边，**系统从不自动建边，只提示候选**）。
- **4.3.3 发展（生命周期）**：`StatusPill`（draft 灰 / verified 绿 / archived 暗 / conflict 琥珀）+ `LifecycleActions`（Verify/Archive/Supersede/标记冲突），**全部改 status 不删文件**，statusFilter 切 archived 即可捞回。
- **4.3.4 写（度量，不施工）**：本页**不主导写、不提供新建记忆入口**。只做：簇治理顶部 `DuplicationTrendBar`（复用 Metrics 页 Recharts）把"快照爆发"可视化当验收看板；Edit 升级为可顺手改 status/confidence/tags（复用已有 PUT）。

---

## 5. 默认安全设计（逐条）

- **5.1【结论】硬删退场**：详情面板红色「Delete（不可撤销）」从 UI 彻底移除，改为可逆 **Archive**（`status='archived'`，statusFilter 可切回）。物理 DELETE 端点后端保留但本页不再调用。
- **5.2【结论】折叠而非合并**：折叠只影响显示、不动底层数据；展开可见全部 N 条原文。
- **5.3【结论】合并/取代可预览可撤销**：裁决先显示状态变迁预览；merge 把 loser 内容以 facet 挂在 winner 之后（`mergedInto` + archived），**不删正文**；提供 Undo。
- **5.4【结论】共存为缺省叙事**：簇治理在 `same-topic`（互补）上**预选"共存"**；只有 cos 极高 + 词法也高的 `same-as` 才默认建议合并，门槛抬高。
- **5.5【结论】无"一键硬合并"批量按钮**：批量只提供"全部接受建议"（尊重每簇保守默认）与"全部共存保留"；破坏性动作走 ConfirmDialog 二次确认，文案为非危险态。

---

## 6. 后端配套（已具备 vs 需新建，含工作量与坑）

> **【坑 6.0】真实门槛**：先把 `MemoryLifecycle` 实例化 + `vectorIndex` 挂上 `ZeroOS` 接口 + 传给 `createRoutes`。这是 P1 的真实前置，不是"挂一行"。

- **6.1 低（已具备，只需暴露）**
  - `POST /api/memory/:type/:id/archive` — `store.update(status:'archived')`，可绕开 lifecycle 直接做（P0 即可）。
  - `POST /api/memory/:type/:id/verify` — 包 `lifecycle.verify()`（前提 6.0）。
  - `POST /api/memory/resolve-conflict {type,id1,id2}` — 包 `lifecycle.resolveConflict()`。**【坑】**它只用 `confidence→updatedAt` 裁决（正是 3.4 要求退出主链的两个被污染字段），且只能裁"你已知的一对"，**无冲突检测能力**。
- **6.2 中（需新建）**
  - Memory schema 加 `topicKey?` / `supersededBy?` / `mergedInto?` + 新增并行 `edges?:{toId,kind}[]`（见 3.5）。`store.parseFile` 透传。
  - `POST /api/memory/:type/:id/supersede {bySupersededId}` — 设 supersededBy + archived + 写演进边。
  - `PATCH /api/memory/:type/:id/relations {add,remove}` — 维护带类型边。
  - `GET /api/memory/neighbors/:type/:id` — **【坑】别低估**：`query()` 吃查询向量不吃 id，封装层 `getMetadata` 又剥掉了向量。要按 id 找近邻必须给向量库加 `getVector(id)`（vectra 底层 `getItem().vector` 可桥接，是新代码），否则就得重嵌入正文（**计费 API 调用**）。
- **6.3 中→高（二期，首发可降级）**
  - `GET /api/memory/clusters` + `POST /api/memory/cluster` — 离线全库 `cos≥0.90` 连通分量聚类、写 topicKey。**【坑】真离线批处理**：vectra 是暴力 O(n²) 线性扫描；代码库**无 job/queue/worker 基础设施**，"异步聚类"是净新建工程。
  - `POST /api/memory/cluster/:id/resolve` + `restore`(Undo) — 编排端点 + 裁决前快照。
- **6.4 必须处理的降级点**
  - **【坑】re-embedding 计费**：每次改 status 走 `IndexedMemoryStore.update` 会触发一次远程 embedding（计费+延迟），且 archived 项仍被 upsert 留在索引占 topK。**需一条 metadata-only 更新路径**，否则"点一次按钮花一次钱"。
  - **【坑】topicKey 未就绪时折叠降级**：聚类端点就绪前，折叠只能临时按 `sessionId+type` 分组——但实测主导重复是**跨会话语义近重复**，sessionId 分组对真正的重复**无效**，只能折叠"显然同源的"。需在 UI 诚实标注这是占位降级。
  - **【坑】冲突按钮半残**：`status:'conflict'` 全代码库从未被任何逻辑设置过，"标记冲突"在有冲突检测前只能裁人工已知的一对。

---

## 7. 分期交付（对齐 关联→发展→读→写，但 P0 先止血）

### 7.1 P0 — 最小可交付止血（前端为主，后端浅改）
- 前端：① 硬删 Delete → **Archive + StatusPill**；② **「按主题折叠」开关 + ClusterGroup**（先用 `sessionId+type` 临时分组，UI 标注降级）；③ `MemoryItem` 接口加 4 个可选字段对齐后端。
- 后端：`POST .../archive`（低）+ schema 加字段（中）。**不依赖聚类、不依赖 vectorIndex。**
- 用户立刻看到：删除不再"删了就没"；列表不再 24 条刷屏；归档可在状态筛选切回。
- 验收：删除操作 0 处不可逆；折叠开/关行为正确；归档项默认不进折叠封面。

### 7.2 P1 — 关联可见 + 生命周期点亮（地基补齐）
- 前端：`RelationBadgeRow` + `RelatedTopicsSection` + `NeighborPicker` + 全套 `LifecycleActions`。
- 后端：**实例化 lifecycle + 挂 vectorIndex 到 ZeroOS（6.0 门槛）**；`neighbors`（中，需 `getVector`）；`verify/supersede/resolve-conflict`（低-中）；**新增 `edges` 字段**而非寄生 related；metadata-only 更新路径（6.4）。
- 用户看到：记忆之间第一次有"带类型、可点击"的边；draft 可被人工 verify、被新版 supersede。
- 验收：建边/跳转闭环；状态机迁移正确且可回看；改 status 不触发多余 re-embedding。

### 7.3 P2 — 簇治理工作台 + 写柱看板（批量止血）
- 前端：簇治理 Tab（`ClusterQueueList` / 边类型选择器 / 裁决预览 / 已裁决 Undo）+ `DuplicationTrendBar`。
- 后端：`clusters` 离线聚类 + job 基础设施（高，真新建）；`cluster/:id/resolve` + `restore` 快照（中）。折叠从 sessionId 切真 topicKey。
- 用户看到：148 个待裁决簇可批量审、可逆裁决；趋势条把"写得太碎"量化，为写粒度改造立基线。
- 验收：任一裁决可 Undo；裁决预览与实际落库一致；默认建议偏共存。

### 7.4 P3 — 写粒度改造（本页之外）
- 写入粒度改造（活文档 / in-place 更新 / 会话收尾沉淀），治本灭"模式一"。本页只被动受益，不在 `memory.tsx` 内施工。

---

## 8. 被否决的做法（避坑清单）

- **8.1** "关联图视图"作首屏 —— P1 就要 GraphCanvas + 多布局引擎 + 1786 节点虚拟化，且 same-topic 边/簇全建立在**不存在的 topicKey**上，冷启动几乎无真边。最重且最无数据支撑，违背"别一上来大重写"。
- **8.2** "演进时间线"作主体 —— Memory **没有 per-transition 事件日志**（只有单 createdAt + 被污染 updatedAt），存量条时间线塌成一个孤点；要真实必须新建 append-only 事件存储（高工作量）。
- **8.3** 把聚类/neighbors 标为"已具备·低" —— 实为净新建（见 6.2/6.3）。**避坑：先确认 lifecycle/vectorIndex 是否挂在 ZeroOS（答案：没有）。**
- **8.4** 把带类型边寄生进 `related[]` 字符串前缀 —— 会与 resolveConflict 双写污染。**避坑：新增 `edges` 并行字段。**
- **8.5** 任何"一键硬合并/全选 merge" + 保留"永久硬删除"作为主操作 —— 与"会生长、可回看"心智冲突，必须退场。

---

## 9. 待你拍板的决策点（汇总）

> 以下每条给了我的倾向，请逐条 ✅/改/否：

- **【决策 D1】P0 范围**：是否同意 P0 = 硬删改可逆归档 + 主题折叠开关(sessionId 降级分组) + StatusPill，纯前端 + 一个 archive 端点？ —— *我的倾向：是，最快止血。*
- **【决策 D2】折叠默认态**：默认**关**（=今天的扁平列表，零回归）还是默认开？ —— *倾向：默认关。*
- **【决策 D3】边的存储**：新增并行 `edges` 字段（不污染 related）？ —— *倾向：是。*
- **【决策 D4】裁决默认动作**：分级（仅 `cos≥0.97` 且事实等价的纯重复可自动 merge，其余共存/待确认）还是全部人工？ —— *倾向：分级，且默认偏共存。*
- **【决策 D5】落盘策略**：治理动作全程 dry-run + 人工确认（含批量"接受建议"也先预览）？ —— *倾向：是，归档不删、可 Undo。*
- **【决策 D6】topicKey**：引入为一等字段，且 key 来自语义聚类的簇签名（非 host/IP/tag 拼接）、允许主 topicKey + 多 relatedTopic？ —— *倾向：引入。*
- **【决策 D7】裁决者**：规则为主、LLM 只判灰区且不直接写库？ —— *倾向：是。*
- **【决策 D8】异步驱动 & 窗口**：聚类/治理走异步（周期 + pending 触发），可接受的"治理延迟窗口"上限多久？ —— *倾向：异步，窗口分钟~小时级可调。*

---

## 10. 完成标准（每个阶段交付前自检）

- 10.1 对比主分支：折叠关 = 行为不变（零回归）。
- 10.2 任何"删除/合并/取代"动作都可逆、可回看（归档非物理删）。
- 10.3 改 status 不产生多余的 embedding 计费调用（metadata-only 路径生效）。
- 10.4 UI 上所有"降级/占位"状态都有明确标注，不误导（如 sessionId 分组、聚类未就绪）。
- 10.5 资深工程师视角自检："这是引入了关联/发展，还是只换了皮？"

---

## 11. 实施进度（2026-06，loop 自动推进）

**P0 ✅ 代码完成 · 静态验证通过**
- 硬删 → 可逆 Archive + `StatusPill`；「按主题折叠」开关（topicKey 未就绪，降级按 sessionId+type 分组，UI 已标注）；`Memory`/`MemoryItem` 加 `topicKey?/supersededBy?/mergedInto?/edges?`；`POST .../archive` 端点。

**P1 ✅ 代码完成 · 静态验证通过**
- 后端：`verify` / `supersede`（被取代方 supersededBy+归档）/ `relations`(PATCH 独立 `edges`) / `neighbors`(向量近邻) 端点；`vectorIndex` 接进 ZeroOS；向量库加 `getVector`。
- 前端：详情区 Verify 按钮、「关联与演进」展示区（edges/supersededBy/mergedInto 可点跳转）、`NeighborPicker`（查近邻→选边类型建边 / 标记被取代）。

**P2 ✅ 代码完成 · 静态验证通过**
- 后端：向量库 `listAll` + `GET /api/memory/clusters`（按需 cos≥0.9 union-find 聚类，无新建 job 基础设施；O(n²) 同步，标注待缓存/异步化）。
- 前端：[浏览]/[簇治理] Tab 切换 + `GovernanceView`（簇列表 + 成员裁决，复用 archive/supersede，默认共存、归档可逆、本地标记避免重复聚类）。

**验证**：`bun run check` 0 错（全 monorepo）；`bun test packages/memory/` 76/76；`bun run build:web` 通过；新增 store/vector-index 往返测试。

**仍待办**
- 运行时验证：运行的 `cli.ts start` 无 --watch，需**重启服务**才能点动新端点（用户操作）。
- P1 deferred：改 status 经 `IndexedMemoryStore.update` 仍触发 re-embed → 待加 metadata-only 更新路径。
- 聚类/topicKey 持久化、clusters 缓存/异步化（P2-later）。
- **P3（本页之外，未做）**：写入粒度改造（活文档 / 会话收尾沉淀），动 agent 写入核心，需单独拍板。
- 对抗式代码评审已完成（20 agent，13 确认项）并修复：1 high（聚类余弦维度守卫，防换模型后 NaN）+ 2 medium（relations `add` 批内去重、supersede 注释澄清）+ 2 low（supersede/relations JSON 容错、GovernanceView 刷新重置 selectedIdx）。其余为设计选择/已知 deferred：DELETE 端点后端保留（前端不调）、mergedInto 无 setter（merge 是 P2-later）、status 改动仍 re-embed（待 metadata-only 路径）、clusters O(n²)/折叠降级（已注释+UI标注）。修复后 `check` 0 错 / `memory` 76 测试 / `build:web` 全绿。
- **运行时验证(2026-06)**：新增 `apps/web/src/api/__tests__/routes-memory.test.ts`，用最小 zero stub + `app.request()` 实跑全部新端点（clusters/neighbors/verify/relations 去重/supersede/archive/400/404）→ **8/8**；真实向量索引只读验证：`listAll` 1893 条、维度统一 1024、聚类 152 簇/475 条/1.1s；既有 `routes.test.ts`+`routes-extended.test.ts` **79/79 零回归**。
- **据验证调整**：权威条排序原为「archived→confidence→updatedAt」，验证发现它让 newer 的 draft 击败 verified、且依赖被污染的 updatedAt。已改为 **verified 优先 → confidence → updatedAt(仅末位兜底)**，前端 `pickCover` 与后端 clusters winner 一致（对齐设计 3.4）。
- **UI 端到端验证(2026-06，`bun zero restart` 重启后端为新代码 + chrome-cdp 驱动真实浏览器)**：
  - 前端：折叠/展开/降级提示、簇治理 Tab 切换、详情面板(StatusPill/Archive/Verify 条件渲染/NeighborPicker)、错误降级——全部正确。
  - 真后端 curl e2e(临时记忆,真实数据零残留)：verify / relations 批内去重(3→2) / supersede / 400 / 404 / neighbors / clusters **10/10**。
  - 真实数据 UI：簇治理显示 **152 簇 / 475 落簇**(与独立分析吻合)，最大簇 24(ComfyUI)，★建议权威条为 verified 条(验证了 winner 修复)。
  - UI 写闭环：点 Verify → 后端 status=verified/conf=0.9 → UI 同步(StatusPill 变色、Verify 按钮隐藏)。
  - 全程仅用临时记忆做变更，已删除核对 0 残留；服务现运行新代码(PID 重启)。

---

## 12. P3 写入收敛实施进度（loop 自动推进）

用户已拍板的决策：① 合并=**有界 section append** ② 折叠键=**叠加向量相似度** ③ 范围=**mode-2 纳入本期**。

- **P3a ✅ 会话内活文档折叠（治 mode-1，flag 默认关）**
  - 第 1 步：`CONTEXT_PARAMS.memory.{liveDocEnabled,liveDocMaxChars}`；`ToolContext.liveDocHandle?`；`Session.liveDocs` Map + `deriveLiveDocKey`(type+tags 归一化，纯内存态)；`memory.ts` create 命中同主题 → **有界 append 合并 + update**，否则 create+register。测试 3。
  - 第 2 步：`IndexedMemoryStore.findSimilar`(embed+向量查询)+ `liveDocVectorEnabled/liveDocSimThreshold(0.92)` flag；route tag-key 未命中 → **向量兜底**(治 tag 漂移，限本会话活文档+阈值)。测试 2。
  - 验证：`check` 0 错、memory 包+工具+completion-gate **124/0**、agent 循环/nudge 零侵入。
- **P3b ➖ 折入 P3c**：全局聚类是 within-session 的超集，单独做"会话收尾定稿"=重复轮子，已并入 P3c。
- **P3c ✅ 跨会话检测自动化 + 人工确认（用户选了非破坏性方案）**
  - P3c-1：聚类逻辑抽成 `@zero-os/memory` 的 `computeMemoryClusters`（`/api/memory/clusters` 端点与后台检测共用）。routes-memory 测试守护行为不变。
  - P3c-2：`getMemoryClusters` 进程内 TTL(60s) 缓存 + `invalidateClusterCache`（archive/supersede 后失效）+ 端点 `?fresh=1` 强制重算 + 前端「刷新聚类」走 fresh。治理 UI 不再每次加载都重算 O(n²)。
  - **实际归档/取代仍在 P2 UI 人工确认**（用户选定）；自动归并未做（用户未选，破坏性动作不擅自上）。
  - 验证：`check` 0 错、memory 包 + routes-memory **86/0**、`build:web` 通过。
  - 可选未做：main.ts 定时预热缓存（proactive cron）——lazy-TTL + on-demand 已够用。
- 全程 flag 默认关（`liveDocEnabled`/`liveDocVectorEnabled`），需用户影子标定折叠率后再开启。

### 12.1 P3 对抗评审 + 真实效果回放（2026-06-10）

**真实数据回放**（真实历史记忆 + index.json 真实向量，只读）：
- **tag 键折叠在真实数据上仅消除 1%** —— agent 每阶段给的 tags 都不同，tag 漂移是常态；**向量路径才是主力，不是兜底**。
- 簇级效果（th=0.90，按会话回放）：**ComfyUI 24→4、ADB 咔皮 7→1、eSee 8156 8→2、UFSMTT 8→3**；全部近重复簇成员 475 条 → 283 条（**会话内重复消除 40%**；th=0.92 仅 29%）。跨会话簇（如 NAS 9条/6会话）不折叠=设计内（P2 治理范围）。
- 据此调整：`liveDocSimThreshold` 默认 **0.92→0.90**（与聚类入簇阈值一致；折叠是 append 不丢内容，风险可控）。

**对抗评审**（27 agent，21 条确认）→ 已修复：
- [high] `Session.restore()` 漏初始化 `liveDocs` → 恢复后 TypeError（已加入 Object.assign）。
- [high] `findSimilar` 全库 top-20 召回缺陷（候选被历史同主题挤出）→ 改为**候选直接 getVector 精确余弦**（O(k) 无召回问题）。
- [high] 向量候选跨 type → update 必 miss 白付 embedding → 候选按 `type|` 前缀过滤。
- [high] embedding/向量查询失败会炸掉整个 memory create → `findSimilar` 整体 try/catch + memory.ts route 调用 `.catch(()=>undefined)`，**折叠 best-effort 绝不阻断写入**。
- [high] 缓存失效缺口：POST create / PUT update / DELETE / verify / relations 全部补 `invalidateClusterCache()`（原只有 archive/supersede）。
- [high] `mergeLiveDocContent` 单节超 maxChars 不受限 → 硬截断兜底；[med] `ex.includes(inc)` 子串误吞 → 改小节级全等去重。
- [med] 全空白 tags 产生 `type|` 碰撞键 → 归一化后为空退化 title slug。
- [high] 真实链路缺测试 → handle 抽成 `packages/core/src/session/live-doc.ts`（session 与测试共用同一实现），新增向量兜底/合并边界/截断/缓存失效端到端测试。
- **判定设计内不修**：initAgent 不清 liveDocs（折叠是会话级作用域，跨 agent 重建保留是有意的）；FIFO 丢最旧（用户拍板的有界 append 语义）；flag 构建时读取（会话内行为一致性）。
- 验证：`check` 0 错；memory 包+工具+completion-gate+routes-memory **139/139**；session 套件 **81/81**（含 restore）；`build:web` 通过。

### 12.2 Flag 开启 + 检索权威解析 + Opus 4.8 对抗（2026-06-10，已全部上线）

**Flag 已开启并上线**：`liveDocEnabled`/`liveDocVectorEnabled`=true（阈值 0.90），P3a 折叠生效。

**检索只取权威条（读柱补完，agent 侧）**：`retrieval.ts` 新增谱系重定向——命中条沿 `supersededBy??mergedInto` 链（visited 环守卫 + 100 跳保险丝、findById 跨 type）重定向到活权威条；多命中重定向同一权威去重保留最高向量分；`resolvedFrom` 溯源。**真实服务器 e2e 决定性验证**：查询命中 A → supersede(A by B) 后返回 B（B 内容与查询无关，只可能来自重定向）。

**Opus 4.8 对抗测试**（14 agent，4 攻击面实跑测试，只报可复现）：**8 确认缺陷全修 + 30 个攻击点守住**（环守卫/自指/断链/跨type/resolvedFrom/去重/winner退化/大边数组/畸形输入防御等）：
- [high] **verify 僵尸态**：supersede 后 verify 不清谱系指针 → 检索把复活权威条重定向到废弃条（交付错误内容/丢结果）→ verify 清除 supersededBy/mergedInto + `store.update` 支持显式 undefined 删字段。
- [med] resolveAuthority 10 跳截断停中间节点 → 上限提至 100（环由 visited 守卫）。
- [med] confidence/tags 门槛只看权威条致召回坍塌 → 改"命中条或权威条任一满足"（status 仍必须看权威条）。
- [med] supersede 无校验（自指/幽灵目标/成环可落盘）→ 400/404/409 三道校验。
- [med] relations remove 粗粒度 + add 静默吞 remove → remove 支持 `{toId,kind}` 精确删，且 remove 后于 add 生效。
- [med] 降级线路 DELETE 不删向量→幽灵簇成员/近邻 → 路由层兜底 `vectorIndex.delete` + clustering 剔除幽灵成员 + neighbors 用 store 实时数据覆盖并跳过幽灵。
- 验证：`check` 0 错、**230/230**（+6 回归锁）、build 通过、重启上线后 live 烟测（自指 supersede→400）。

### 12.3 Opus 4.8 对抗多轮收敛（R2–R4，2026-06-10，已全部上线）

承 12.2 的 R1，继续做 loop-until-dry 多轮对抗，直到一轮无功能缺陷。**核心架构洞察：不变量校验只在语义端点（supersede/verify）做是不够的——共用写入层（PUT 端点 / memory 工具 update / `store.update`）是绕过一切校验的旁路。R2 起把校验下沉/收口到写入层。**

**R2（7 确认，4 high）—— 校验旁路类，根因结构性修复：**
- [high] PUT `/api/memory/:type/:id` 原样转发 body 到 `store.update`，可写自指/成环/幽灵指针/僵尸态 → **PUT 字段白名单**（仅 title/content/tags/confidence；status 走 verify/archive、谱系走 supersede、edges 走 relations）。
- [high] `store.update` 无差别 undefined-strip 删必填字段：`content:null/undefined` → `matter.stringify` 崩溃 → **strip 白名单**（仅可选谱系/元字段可清；必填字段 null/undefined 忽略保留原值）+ save() 非串 content 兜底 `''`。
- [high] 活文档折叠只查存在不查 status：会话中途文档被归档/取代后同主题新写入继续折进归档文档 → 检索黑洞 → `route()` 两路径都查 `isActiveFoldTarget`（非 archived 且无谱系指针）。
- [high] supersede 成环检测 100 跳 `break` 是 fail-open，≥102 深链可绕过把真环落盘 → **visited 终止（无数值熔断）+ 路径压缩**（supersededBy 指链尾活权威，链深恒 ≤1）。
- [med] PUT status 无枚举校验（被 PUT 白名单一并堵死，create 端点遗漏留到 R3）。
- [med] resolveAuthority 100 跳熔断停中间节点 → 改 **visited 终止无熔断**。
- [low] PUT 写畸形 edges（被白名单堵）。
- 提交 `a3dcbcf`。

**R3（3 确认，0 high）—— 校验一致性补完：**
- [med] POST `/api/memory` create 端点 status 无枚举校验（PUT/工具已加，create 漏）→ 可植入任意 status / 直接 verified → create 端 `isMemoryStatus` 校验。
- [low] confidence 三路写入（create/PUT/工具）无 [0,1] 钳制 → 共享 `clampConfidence`。
- [low] supersede 路径压缩注释称"链尾活权威"但未排除 archived → 压缩到**最后一个活节点 `lastLive`**，整链全归档回退直接 target。
- 新增共享 `isMemoryStatus`/`clampConfidence`（`packages/shared`），三路写入统一调用。提交 `3ae83d1`。

**R4（1 确认，0 high/0 med，收口轮）—— 实质干净：**
- [low] `GET /api/memory/clusters?threshold=abc` → `Number('abc')=NaN` 穿透 `[0.8,0.99]` clamp → 所有 cos≥NaN 恒 false → 近重复簇静默归零（现网 UI 不传 threshold 不可达）→ `normalizeThreshold()` 非有限值归一默认 0.9（compute + getCached 共用，缓存键也规范化）。提交 `1ef7cca`。
- R4 大批 passedChecks 确认 R1–R3 修复全部闭合：clampConfidence/isMemoryStatus 各边界、supersede lastLive 多跳压缩+全归档回退、retrieval 空 query 短路、relations/neighbors/clusters/折叠边界、谱系隔离未回退。

### 12.4 Opus 4.8 对抗 R5（功能正确性向新角度，2026-06-10，已上线）

R1–R4 主攻【写入校验/绕路/畸形输入】(安全向)且收敛后，用户再次重启 loop。R5 换【功能正确性向】新角度——验证关联/发展"做对了事"，而非只"挡住坏输入"。

**读柱交付正确性（大批 passedChecks 确认全对）**：跨 type mergedInto 重定向交付活权威本体（id/type/content 对）；topN 截断在 byAuthority 去重【之后】不丢真权威；评分多命中去重取 max；resolvedFrom 溯源（自身命中不入、两跳只记最初命中）；门槛"命中或权威任一满足 confidence/tags"各组合正确；status 门槛只看权威条；悬挂谱系指针/环/自环防护（visited 终止）。关联图大多设计内（edges 不入任何交付/聚类路径，纯人工标注）。

**2 确认（0 high/0 med，均 low、均有界、均已修）**：
- [low] **折叠 TOCTOU**：`route()` 判活与 `store.update` 落盘之间有 await 窗口（findSimilar），期间文档被 web `/archive`|`/supersede` 端点改掉（与 agent 折叠写无共享 mutex——Session Mutex 只串行化会话内 turn，不同步 web 端点），新内容写进死文档成孤儿（检索黑洞，有界）。代码预见了"删除竞态"（update 返回 undefined → 降级 create）却漏了"归档/取代竞态"（update 返回 truthy → 折叠"成功"进死文档）。**修**：`store.update` 加 commit-time `precondition`，在 get→save 同步临界区内复检；折叠路径传 `isActiveFoldTarget`，不满足则中止、降级 create。（注：同会话并发折叠丢写判 false——agent-loop 串行 + 消息级 Mutex 双重串行化，per-Session liveDocs 不可能真并发。）
- [low] **neighbors 返回死节点当顶级"选取代来源"且不带 status**——与 clusters/retrieval 跨面不一致（误导治理 UI，但下游 supersede 会压缩到活权威，无数据损坏）。**修**：payload 补 `status`/`supersededBy`/`mergedInto`，与 cluster 成员一致，让治理者看见死节点。
- 提交 `a6b8f24`。

**总收敛结论**：缺陷数 R1→R5 = 8→7→3→1→2，high 数 多→4→0→0→0，R4/R5 连续两轮 0 high/0 med（仅 low 有界边角）。**两个角度（安全/绕路 + 功能正确性）均已收敛；关联（typed edges/relations）与发展（supersede/verify 生命周期 + 路径压缩 + 检索权威解析）功能确认正常。** 累计 **244 测试全绿**（+19 R2–R5 回归锁），每轮 `check`+build+重启上线+live 烟测。对抗测试纪律：只攻 mkdtemp/stub 临时数据，绝不碰真实 `.zero/memory`，绝不改产品代码，临时测试跑完即删，0 残留。
