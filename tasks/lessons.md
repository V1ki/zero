# Lessons（自我改进循环）

## 校验/不变量必须下沉到共用写入层，而非散落在语义端点

**场景**：记忆图谱系（supersededBy/mergedInto）的校验最初只加在 supersede/verify 端点。Opus 对抗第 2 轮发现 PUT `/api/memory/:type/:id`、memory 工具 `update`、底层 `store.update` 都能原样写入，把自指/成环/僵尸态/非法 status 落盘，绕过一切端点校验。

**规则**：
- 任何"语义端点做了校验"的不变量，必须问一句：**还有没有别的写路径能触达同一字段？**（通用 PUT、工具直传 updates、底层 store API）。有就一并收口。
- 优先**字段白名单**而非黑名单：通用写路径（PUT/工具 update）只放行安全字段，结构性字段（谱系/edges/status 转换）强制走各自的语义端点。
- 校验逻辑抽成**共享工具**（如 `isMemoryStatus`/`clampConfidence`/`normalizeThreshold`），三路写入统一调用，杜绝"加了一处漏两处"。

## 环检测/链遍历用 visited 终止，不用固定数值熔断

**场景**：成环检测和 resolveAuthority 都用 `for (hops<100) break`，是 fail-open——≥102 深链直接绕过把真环落盘，或截断停在中间节点把陈旧条当权威（召回坍塌）。

**规则**：有限图的链遍历用 `visited` 集合保证终止（每步加新 id，受总数上界约束），**不要用魔法跳数上限**。固定上限既可能 fail-open（环漏判）又可能 fail-truncate（停错节点）。结构上更优的是**写入时路径压缩**（让链深恒 ≤1），从根上消除深链与环。

## NaN 会穿透 Math.min/max 钳制

**场景**：`Math.min(0.99, Math.max(0.8, NaN))` = NaN（不是被钳到边界）。`?threshold=abc` → `Number('abc')=NaN` → 所有 `cos>=NaN` 恒 false → 簇静默归零，且返回 200 "无重复"是误导性成功响应。

**规则**：把外部输入转数值后，clamp 之前先 `Number.isFinite` 兜底为默认值。`x ?? default` 挡不住 NaN（NaN 非 null/undefined）。误导性 200 比报错更危险。

## get-then-save 整体覆盖语义下，区分"清字段"与"不改"

**场景**：`store.update` 想支持 verify 清谱系指针（显式 undefined → 删字段），但无差别 strip 把必填 content 也删了 → 序列化崩溃。

**规则**：整体覆盖（spread updates）语义里，`undefined/null` 含义二义——只对**可选字段白名单**视为"删除"，必填字段的 undefined/null 一律视为"不改、保留原值"。

## route-time 检查 ≠ commit-time 保证（跨上下文 TOCTOU）

**场景**：折叠 `route()` 里判过目标"仍活跃"，但到 `store.update` 落盘之间隔着 await（findSimilar）。这期间 web `/archive`|`/supersede` 端点（与 agent 折叠写共享同一 store、但无共享 mutex）把目标改死，新内容仍写进死文档成孤儿。Session Mutex 只串行化会话内 turn，挡不住"web 端点 vs agent 写"这种跨上下文竞态。

**规则**：
- 不变量在"读时/路由时"成立，不代表"写时/提交时"仍成立。凡判定点与落盘点之间有 await，且别的代码路径能改同一状态，就有 TOCTOU 窗口。
- 修复下沉到**原子临界区内的 commit-time 复检**：找到无 await 的同步 get→write 段（JS 单线程下它相对其他写入原子），在 write 前复查不变量，违反则中止/降级。不要靠"判定时检查一次"。
- 识别真竞态边界：先问"这两条写路径共享 mutex 吗"。会话内串行（agent-loop for-await + 消息级 Mutex）能消除会话内并发，但消除不了 web 端点与 agent 的并发——后者才是真窗口。

## 同一权威模型必须在所有消费者间一致（跨 type vs 单 type）

**场景**：retrieval 和 supersede 端点的谱系解析是跨 type 的（findById 扫 ALL_MEMORY_TYPES，因为 merge 可跨类型）；但 MemoryLifecycle 的 resolveConflict/archiveOld 是单 type 的。同一个"权威模型"在不同消费者里实现不一致 → 跨 type 谱系下选错 winner、误归档活权威。

**规则**：当多个组件声称遵循"同一模型"（注释甚至明说），要验证它们的实现真的一致。最稳的是**抽共享函数**（如跨 type 的 resolveAuthority），让"同一模型"由构造保证而非各自复刻。复刻必然漂移。

## String.replace 的替换串会解释 `$` 模式

**场景**：`content.replace(marker, userText)` —— userText 里的 `$&/$\`/$'/$N/$$` 被当作替换模式展开（$&=匹配串、$\`=匹配前文本、$N=捕获组），用户/agent 自由文本含 `$`（shell $PATH、价格、git HEAD@{1}）时把文档拼坏。

**规则**：替换串含任何不可信/自由文本时，用**函数替换器** `replace(pat, () => text)`——函数返回值不受 `$` 模式解释。这和"用户输入不可信"同理，只是发生在 String.replace 的第二参数这个不显眼处。

## 截断要按字符（码点）而非码元，别切裂代理对

**场景**：`text.slice(0, maxChars)` 按 UTF-16 码元切，正好切在星平面字符（emoji/CJK扩展/数学符号，占 2 码元）中间 → 留半个代理 → UTF-8 编码上线时损坏成 U+FFFD 或被丢。

**规则**：定长截断后检查末位是否落单高位代理（0xD800–0xDBFF），是则丢弃；或用 `[...text]` 按码点切。任何"按长度切字符串"的地方都要想到代理对。

## 修在正确的层，别为关边角牺牲合法能力

**场景**：recency 对损坏 updatedAt 给最高分。诱人的修法是"create 强制 now()、不接受 caller updatedAt"。但 create 接受显式时间戳是 import/migration 的合法能力，强制 now() 反而损害未来 import，且破坏既有测试。

**规则**：一个缺陷可在多层修；选**不牺牲合法能力**的那层。这里真正的 bug 是"评分让损坏时间戳获胜"，修在 recency（NaN→最旧）即可中和危害，不必阉割 create。修复前问："这一层的改动会不会关掉某个正当用途？"

## 区分"真实缺陷"与"生产可达"

**场景**：MemoryLifecycle 全套是真实逻辑缺陷，但 grep 全仓零生产调用方（dormant）。对抗后期大量发现落在 dormant 代码。

**规则**：报告/定级时把 `isReal`（逻辑是否真错）与 `reachable`（生产是否可触发）分开。以"**0 生产可达缺陷**"作为收敛/停止判据，dormant 真实缺陷修不修取决于成本与未来接线计划（廉价且属同类一致性的就顺手修）。

## 接线 dormant 代码会暴露新集成缺陷——测接线后的路径

**场景**：MemoryLifecycle 的单元逻辑经 R6–R8 充分加固，但它 dormant（无生产调用方）。一旦接入 HTTP 端点变为生产可达，R9–R12 立刻发现 5 个新的可达集成缺陷（跨 type 入参、Date 溢出、并发丢更新、段序非原子、缓存竞态）——全是【端点/并发/失败模式/store 实现交互】层面的，单元测试照不到。

**规则**：把 dormant 代码接线时，要把它当全新功能对待——测【接线后的端到端路径 + 并发 + 失败模式 + 与共享单例(store/cache)的交互】，而非只信任既有单元测试。可达性一变，攻击面就变。

## 多步非原子 mutation：排序写操作使部分失败落安全态

**场景**：resolveConflict 做两次独立 await 的 store.update（归档 loser、复活 winner）。文件存储 + 向量索引没有跨写事务。旧序（loser 先）下 winner 段失败 → loser 已归档指向 archived-winner → 召回坍塌。

**规则**：无法事务化的多步 mutation，**排序写操作，使任何前缀完成都是安全态**。这里把 winner 复活提到 loser 归档之前：winner 段失败→无提交；loser 段失败→winner 已活+loser 仍活（无坍塌），重试幂等补完。先问："如果在第 k 步后崩溃，留下的状态安全吗？"——重排到答案永远是"是"。

## 元字段更新不该触发昂贵/易错的副作用（re-embed）

**场景**：IndexedMemoryStore.update 对任何更新都 re-embed（调真实 embedding 服务），即便只改 status。这给 archive/supersede/verify/archiveOld 这些纯元字段写都加了一个网络失败点（R10/R11 的失败窗口根源），也浪费算力（内容没变向量不变）。

**规则**：写路径若对"内容未变、仅元字段变"的更新仍触发重计算/外部调用，是隐藏的失败面 + 浪费。理想是检测 content/title/tags 未变则跳过 re-embed。（已记为优化点；当前用 commit-time precondition + 段序 + 逐条容错从下游兜住。）

## 缓存失效与重算并发：用 epoch 代际守卫

**场景**：getMemoryClusters 重算横跨 await；重算期间 invalidateClusterCache() 把缓存置 null，但 in-flight 重算完成后无条件回写，复活了陈旧缓存。

**规则**："重算 N 秒 + 期间可能被 invalidate"的缓存，置 null 不够——in-flight 重算会覆盖失效。用**代际计数**：invalidate 时 epoch++，重算前记 startEpoch，完成后仅当 epoch 未变才回写。这是 compare-and-swap 思路在单线程异步缓存上的应用。

## Opus 多轮对抗的纪律（沿用并固化）

- loop-until-dry：每轮"攻击面→实跑测试→只报可复现→复现验证（设计内判 false）"，直到一轮 0 high/med。趋势看 high 数（多→4→0→0 即收敛）。
- 子代理只攻 mkdtemp/createRoutes-stub 临时数据，**绝不读写真实 `.zero/memory`，绝不改产品代码**，临时测试跑完即删（0 残留）。
- 每轮修完即 `check`+全量测试+build+重启上线+live 烟测，再分轮提交。
