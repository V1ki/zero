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

## Opus 多轮对抗的纪律（沿用并固化）

- loop-until-dry：每轮"攻击面→实跑测试→只报可复现→复现验证（设计内判 false）"，直到一轮 0 high/med。趋势看 high 数（多→4→0→0 即收敛）。
- 子代理只攻 mkdtemp/createRoutes-stub 临时数据，**绝不读写真实 `.zero/memory`，绝不改产品代码**，临时测试跑完即删（0 残留）。
- 每轮修完即 `check`+全量测试+build+重启上线+live 烟测，再分轮提交。
