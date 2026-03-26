# ZeRo OS 里程碑与交付标准

本文档定义 ZeRo OS 的分阶段实施计划、每个里程碑的验收标准和测试要求。

> **文档关系说明**：本文档基于 [Architecture]、[TechStack]、[ContextEngineering] 和 [UI-UX] 四份规格文档设计。包间依赖关系以 [TechStack - 包间依赖关系] 为权威源。

---

## 关键路径

基于 [TechStack - 包间依赖关系] 的层级拓扑：

```
Level 0: shared                    ← 所有包的基础
Level 1: observe, secrets          ← 仅依赖 shared，可并行
Level 2: memory (shared+observe), model (shared+observe+secrets)
Level 3: core                      ← 依赖 shared+model+memory+observe+secrets
Level 4: channel, scheduler, health ← 依赖 shared+core，可并行
Level 5: apps/server               ← 组装 core+channel+scheduler+health
Level 6: apps/web, apps/supervisor ← web 通过 HTTP/WS 通信，supervisor 无内部依赖
```

关键路径：**shared → observe+secrets → model → core → server → web**

### 里程碑依赖图

```
M1 (基础层)
 └─→ M2 (安全+模型)
      ├─→ M3 (记忆系统)
      │    └─→ M4 (核心引擎)
      │         └─→ M5 (通道+调度+健康)
      │              └─→ M6 (主进程+Supervisor)
      │                   ├─→ M7 (Web UI)
      │                   └─→ M8 (自修复+强化) ← 依赖 M6+M7
      └─────────────────────────────────────┘
```

### 规模总览

| 里程碑 | 新文件(估) | 测试文件(估) | 涉及包 | 风险 |
|--------|-----------|-------------|--------|------|
| M1 | ~15 | ~10 | shared, observe | 低 |
| M2 | ~15 | ~12 | secrets, model | 中 |
| M3 | ~10 | ~8 | memory | 中 |
| M4 | ~18 | ~15 | core | **高** |
| M5 | ~18 | ~14 | channel, scheduler, health | 中 |
| M6 | ~8 | ~8 | server, supervisor | 中 |
| M7 | ~50+ | ~25 | web | 中 |
| M8 | ~12 | ~15 | 跨包 | **高** |

---

## M1: 基础层 — 类型系统 + 观测性

**范围**: `packages/shared` + `packages/observe`

**构建内容**:

- shared: 全局类型定义 (session/message/tool/memory/config)、工具函数 (id/time/yaml/lock/case-convert)
- observe: observability store、SQLite metrics 聚合、trace 记录、secret-filter

### 验收标准

1. `bun install` 成功，workspace 内 `@zero-os/observe` 可正常 import `@zero-os/shared`。
2. `bun run --check` (tsc --noEmit) + `biome check` 零错误。
3. ID 生成产出合法 UUIDv7，时间工具产出正确 ISO-8601。
4. YAML 工具可往返解析 config.yaml fixture。
5. 文件锁可获取/释放，并发竞争时正确阻塞。
6. case 转换正确处理 camelCase ↔ snake_case（含嵌套对象、数组）。
7. observability store 负责写入全局事件流并从 `trace.jsonl` 投影请求、快照、closure、decision 视图；每行都是合法 JSON。
8. secret-filter 可从任意字符串中擦除已知密钥值。
9. SQLite metrics 可建表 + 从 JSONL fixture 执行基础聚合查询。

### 测试标准

| 模块 | 最低用例数 | 要点 |
|------|-----------|------|
| id.ts | 3 | 唯一性、格式校验、单调递增 |
| time.ts | 5 | ISO 格式、相对时间、时长计算 |
| yaml.ts | 4 | 解析、序列化、往返保真、非法 YAML 报错 |
| lock.ts | 4 | 获取/释放、并发竞争、超时、进程退出清理 |
| case.ts | 6 | 简单字段、嵌套对象、数组、单词段、无操作 |
| observability-store.ts | 5 | 单条追加、多条追加、文件创建、JSON 合法、类别路由 |
| secret-filter.ts | 6 | 精确匹配、JSON 内、多行、无误报、空集、部分值 |
| metrics.ts | 4 | 建表、聚合、时间过滤、空数据集 |
| trace.ts | 3 | span 记录、嵌套 span、导出格式 |

**覆盖率目标**: 90%+

### 演示场景

脚本运行 → 生成 ID → 解析 config.yaml → 写 10 条 JSONL → 读回验证 → secret 过滤 → metrics 聚合查询 → 打印结果。

**依赖**: 无（首个里程碑）

---

## M2: 安全层 + 模型层

**范围**: `packages/secrets` + `packages/model`

**构建内容**:

- secrets: AES-256-GCM vault、macOS Keychain 交互、ChatGPT OAuth 流程管理、全局输出过滤器
- model: Provider Adapters (Anthropic Messages / OpenAI Chat Completions / OpenAI Responses)、Router、Registry、流式处理、认证处理（详见 [Architecture - 认证方式]）、费用计算

### 验收标准

1. 主密钥可存入/读取 macOS Keychain。
2. secrets.enc 可加密创建、写盘、读回解密；错误密钥解密明确失败。
3. 凭证 CRUD + 元数据 (type/created_at/expires_at) 持久化。
4. Model Registry 正确解析 [Architecture - Model Registry] 中的完整 config.yaml 示例（6 provider）。
5. Router 执行精确匹配 / 模糊匹配 / 多候选返回。
6. 降级链：主模型 healthCheck 失败 → 自动切换到下一个。
7. 三种 Adapter 各自可发起真实 API 调用并收到响应。
8. Anthropic OAuth Token 认证：`authToken` 参数 + `apiKey: null` + Beta Headers（详见 [TechStack - 认证处理]）。
9. 流式输出：`stream()` 返回 `AsyncIterable<StreamEvent>`，事件格式统一。
10. HealthCheck 检测不可达 / 401/403 凭证失效 / 正常。
11. 费用计算与 [Architecture - 模型定价与用量追踪] 中的公式一致。

### 测试标准

| 模块 | 最低用例数 | 要点 |
|------|-----------|------|
| vault.ts | 6 | 加解密往返、错误密钥、CRUD、元数据、空 vault、删除 |
| keychain.ts | 3 | 存/取/不存在报错（真实 Keychain 交互）|
| filter.ts | 4 | vault 集成、多凭证擦除、动态新增、并发 |
| registry.ts | 5 | 完整解析、缺字段报错、单 provider、多 provider、自定义定价 |
| router.ts | 8 | 精确/模糊/歧义候选/无匹配/降级链遍历/降级耗尽/活跃追踪 |
| auth.ts | 4 | API Key 客户端、OAuth Token 客户端(含 null apiKey + beta)、OpenAI header、前缀检测 |
| cost.ts | 4 | 基础计算、缓存定价、reasoning token、零用量 |
| stream.ts | 4 | Anthropic 事件归一化、OpenAI 事件归一化、中断处理、空流 |

**集成测试**（需真实 API Key，CI 无 key 时跳过）:

- Anthropic 真实调用 + 响应结构验证
- OpenAI Chat 真实调用 + 响应结构验证
- 流式真实调用 + 完整事件收集
- 降级链真实触发（坏 key → 备选模型）

**覆盖率目标**: 85%+

### 演示场景

脚本 → 初始化 vault + Keychain → 存入 Anthropic API Key → 加载 config → Router 解析 "opus" → 流式调用 Claude "2+2" → 逐 delta 打印 → 最终 token 用量 + 费用。

**依赖**: M1

---

## M3: 记忆系统

**范围**: `packages/memory`

**构建内容**:

- Markdown CRUD + gray-matter frontmatter 解析
- 向量 embedding pipeline (OpenAI text-embedding-3-small → HNSW via vectra)
- SQLite tag 索引（精确过滤）
- 记忆检索完整流程（shouldRetrieve 决策 → query 生成 → 向量搜索 → tag 过滤 → confidence 阈值），详见 [Architecture - 记忆模块]
- 生命周期管理（写入 inbox → 整理为类型 → 归档 → 冲突检测）
- memory.md 全局索引维护

### 文件列表

```
packages/memory/
  src/
    store.ts          # Markdown CRUD + frontmatter
    index-page.ts     # memory.md 索引维护
    retrieval.ts      # shouldRetrieve() + 查询 + 向量搜索 + tag 过滤
    embedding.ts      # EmbeddingPipeline: text-embedding-3-small → HNSW upsert
    lifecycle.ts      # 记忆写入/整理/归档/冲突解决
    tag-index.ts      # SQLite tag 索引
    vector-index.ts   # HNSW 向量索引封装 (vectra)
    index.ts
```

### 验收标准

1. Memory CRUD: frontmatter 字段 (id/type/title/created_at/updated_at/status/confidence/tags/related) 往返正确。
2. memory.md 索引随记忆增删改自动更新。
3. Embedding pipeline → HNSW 存储 → 语义检索返回 Top-N。
4. 检索流程完整：shouldRetrieve 决策 → query 生成 → 向量搜索 → tag 过滤 → confidence 阈值 → Top-N。
5. Tag 索引支持增删查，多 tag 查询返回交集。
6. 生命周期：inbox → 类型化 → 归档路径畅通。
7. 冲突检测：矛盾记忆按 confidence > updated_at 优先级决策，无法自动时标记冲突。
8. 容量管理：单条大小上限 + 总容量上限 + 低分自动归档。

### 测试标准

| 模块 | 最低用例数 | 要点 |
|------|-----------|------|
| store.ts | 8 | CRUD、frontmatter 往返、文件不存在、非法 frontmatter、大文件 |
| retrieval.ts | 6 | shouldRetrieve 决策、query 生成、向量搜索 mock、tag 过滤、confidence 阈值、空结果 |
| embedding.ts | 3 | embed 文本、upsert 索引、搜索返回最近邻（需 OpenAI API）|
| lifecycle.ts | 5 | 写入 inbox、整理为类型、归档、冲突检测、索引更新 |
| tag-index.ts | 4 | 增删查、多 tag 交集、空索引、重复 tag |
| vector-index.ts | 3 | upsert、search、delete |

**集成测试**: Memory 检索全流程 — 创建多条记忆 → 嵌入 → 用户 query 检索 → 验证返回相关记忆。

**覆盖率目标**: 80%+

### 演示场景

脚本 → 创建 3 条不同类型记忆 (incident/runbook/decision) → 嵌入 → 查询 "上次部署失败怎么解决的" → 返回匹配的 incident 和 runbook → 验证 confidence 过滤生效。

**依赖**: M1 + M2

---

## M4: 核心引擎 — Agent 执行循环

**范围**: `packages/core`

**构建内容**:

- Session 生命周期（创建/消息处理/命令解析/消息排队/drainQueue），详见 [TechStack - Session 生命周期]
- Agent 执行引擎（tool-use loop），详见 [Architecture - 全局架构]
- Tool 基类 + 6 个内置工具 (Read/Write/Edit/Bash/Fetch/Task)，详见 [TechStack - Tool 基类]
- SubAgent 编排器（DAG 执行），详见 [TechStack - SubAgent 编排]
- System Prompt 组装（XML 标签结构），详见 [ContextEngineering - System Prompt 各区块]
- 上下文预算管理 + 对话压缩 + 历史工具输出衰减，详见 [ContextEngineering - 对话管理]
- 消息排队注入，详见 [ContextEngineering - 排队消息注入]
- config.yaml / fuse_list.yaml 解析

### 文件列表

```
packages/core/
  src/
    session/
      session.ts       # Session 类：生命周期、消息队列、busy 标志
      manager.ts       # SessionManager: 创建/获取/列表/清理
    agent/
      agent.ts         # Agent 执行引擎：tool-use loop、排队注入、续接
      prompt.ts        # buildSystemPrompt(): XML 标签组装
      budget.ts        # 上下文预算分配 + 截断
      context.ts       # 历史工具输出压缩
      compress.ts      # 对话压缩：滑动窗口 + 摘要
    tool/
      base.ts          # BaseTool: fuseCheck → beforeExecute → execute → afterExecute
      registry.ts      # 工具注册表
      tools/
        read.ts        # 读文件 (offset/limit)
        write.ts       # 写文件 (path lock)
        edit.ts        # 精确修改 (path lock)
        bash.ts        # 命令执行 (Bun.$ + fuse 检查 + timeout)
        fetch.ts       # HTTP → readability + turndown → Markdown
        task.ts        # SubAgent 创建
    task/
      orchestrator.ts  # DAG 编排：并发/依赖/失败传播/死锁检测
      subagent.ts      # SubAgent 上下文构建（精简 prompt）
    config/
      parser.ts        # config.yaml 解析校验
      fuse.ts          # fuse_list.yaml 解析 + 命令匹配
    index.ts
```

### 验收标准

1. Session: 创建 / handleUserMessage / 命令解析 (/new, /model) / busy 状态 / 消息队列 / drainQueue。
2. Agent tool-use loop 完整：发消息 → 收到 tool_use → 执行工具 → 注入 tool_result → 循环直到 end_turn。
3. 排队消息注入：tool 执行期间来的消息用 `<queued_message>` XML 包装注入。
4. 续接机制：LLM 返回 end_turn 但任务未完成 → 注入 `<system_notice>` 续接，最多 2 次。
5. System Prompt 组装产出正确 XML 结构：`<role>` `<rules>` `<tool_rules>` `<constraints>` `<identity>`；`<system-reminder>` 仅在发现新增 Skill 时按需注入。
6. 上下文预算分配对齐 [ContextEngineering - 预算分配]（claude-opus 200k、gpt-4o 128k、deepseek-r1 65k）。
7. 历史工具输出衰减：近 3 轮全量、4-8 轮摘要、9+ 轮仅状态。
8. 对话压缩：85% 预算时触发，用便宜模型生成摘要，保留 70% 近期消息。
9. 6 个内置工具各自功能正常：Read 读文件 / Write 写文件+锁 / Edit 修改+锁 / Bash 执行+fuse 检查 / Fetch HTTP→MD / Task 启动 SubAgent。
10. Fuse list 检查正确拦截命中命令。
11. 工具输出截断按 [ContextEngineering - 工具输出截断] 限制（Read:8000, Write:500, Edit:1000, Bash:4000, Fetch:6000, Task:2000 tokens）。
12. SubAgent 编排器：DAG 执行、并发无依赖节点、串行有依赖、失败取消下游、死锁检测。

### 测试标准

| 模块 | 最低用例数 | 要点 |
|------|-----------|------|
| session.ts | 8 | 创建、handleUserMessage、命令、busy、队列、drain、排序 |
| agent.ts | 10 | 简单完成、单工具、多工具循环、排队注入、end_turn 续接、最大续接、完成检测、错误处理 |
| prompt.ts | 6 | 完整组装、各 XML 块、仅在新增 Skill 时注入 system-reminder、预算截断 |
| budget.ts | 4 | 各模型预算分配、固定预算强制、截断标记 |
| compress.ts | 5 | 触发阈值、摘要生成 mock、保留消息数、最少保留 4 轮、快照创建 |
| base.ts (tool) | 5 | run 管道顺序、fuseCheck 拦截、hooks 调用、错误传播、输出截断 |
| 每个内置工具 | 各 4 | 正常路径、错误处理、锁行为（适用时）、输出格式 |
| orchestrator.ts | 6 | 单节点、并行、串行依赖、菱形依赖、失败取消下游、死锁检测 |
| fuse.ts | 5 | 精确匹配、glob 模式、安全命令放行、空列表、重载 |

**集成测试**:

- Agent loop 真实多步任务："读文件 X → 创建文件 Y → 读回验证"（真实 LLM 调用）
- SubAgent 2 节点 DAG 执行 + 结果传递

**覆盖率目标**: 80%+

### 演示场景

CLI harness → 初始化 vault+config → 创建 Session → 发送 "创建 hello.ts 写一个返回 'Hello, World!' 的函数，然后读回验证内容" → Agent 自主使用 Write + Read 完成 → 打印完整对话 transcript。

**依赖**: M1 + M2 + M3

---

## M5: 通道 + 调度器 + 健康管理

**范围**: `packages/channel` + `packages/scheduler` + `packages/health`（三者互不依赖，可并行开发）

**构建内容**:

- channel: 基础接口 + 飞书/Telegram/Web 三个实现 + ChannelManager 路由，详见 [Architecture - Channel]
- scheduler: crontab 管理、Session 创建触发、重叠策略 (skip/queue/replace)、misfire 策略，详见 [Architecture - Scheduler]
- health: 心跳写入 (10s)、自修复编排（诊断→修复→验证）、熔断机制、LaunchAgent plist 生成，详见 [TechStack - Supervisor 与 Health 的职责划分]

### 验收标准

1. Channel base interface + ChannelManager 路由到正确 Session。
2. 三个 Channel 适配器各自可接收消息 + 发送回复 + 排队确认。
3. Scheduler 解析 cron 表达式 + 计算下次执行时间 + 操作系统 crontab。
4. 定时触发正确创建 Session + 传入 instruction/model。
5. 重叠策略：skip/queue/replace 各自行为正确。
6. Misfire：run_once 在恢复后补跑。
7. 心跳每 10s 写入文件，文件 mtime 可验证。
8. Health fuse 追踪连续修复失败 + 阈值后 lockdown + 写 incident。
9. LaunchAgent plist 产出合法 XML。

### 测试标准

| 模块 | 最低用例数 |
|------|-----------|
| channel/base.ts | 3 |
| feishu/adapter.ts | 5 |
| telegram/adapter.ts | 5 |
| web/adapter.ts | 4 |
| channel/manager.ts | 5 |
| cron.ts | 4 |
| runner.ts | 4 |
| policy.ts | 5 |
| heartbeat.ts | 3 |
| repair.ts | 4 |
| fuse.ts | 4 |
| launchd.ts | 3 |

**集成测试**:

- Web Channel → Session 创建 → Agent 响应
- Scheduler 立即触发 → Session 执行任务

**覆盖率目标**: 80%+

**依赖**: M4

---

## M6: 主进程装配 + CLI + Supervisor

**范围**: `apps/server` + `apps/supervisor`

**构建内容**:

- server: main.ts 12 步启动序列（详见 [TechStack - 启动流程]）、全局事件总线 (EventEmitter)、CLI (`bun zero init/start/stop`)、交互式初始化
- supervisor: 独立看门狗（无内部依赖），心跳检测 20s / 重启 / fuse + rollback，详见 [Architecture - 自我修复]

### 验收标准

1. `bun zero init` 交互式初始化：Keychain 主密钥 + `.zero/` 目录结构 + Provider 凭证。
2. `bun zero start` 执行 12 步启动序列，顺序正确。
3. 任何启动步骤失败 → 日志记录 + 干净退出。
4. 事件总线正确中继所有子系统事件，匹配 [TechStack - WebSocket 协议]。
5. `bun zero stop` 发送 SIGTERM + 等待干净关闭。
6. Supervisor 独立检测心跳，50s stale → 重启主进程。
7. Supervisor fuse：连续 N 次重启失败 → rollback 到 stable tag。
8. `bun zero init` 创建的 `.zero/` 结构与 [Architecture - 工作区结构] 完全一致。

### 测试标准

| 模块 | 最低用例数 |
|------|-----------|
| bus.ts | 5 |
| cli.ts | 3 |
| init.ts | 4 |
| supervisor/main.ts | 6 |

**E2E 测试**: `bun zero init` → `bun zero start` → Web Channel 发消息 → 收到响应 → `bun zero stop`。

**覆盖率目标**: 75%+

### 演示场景

完整系统启动 → Web Channel 对话 → 观察工具调用 → 验证 JSONL 日志 → 停止 → Supervisor 重启。

**依赖**: M5

---

## M7: Web UI

**范围**: `apps/web` — 完整前端

**构建内容**:

- 后端: Hono API 路由 (typed RPC) + WebSocket Hub，详见 [TechStack - 后端 API]
- 前端: React 19 + TailwindCSS 7 个页面 (Dashboard/Sessions/Memory/Memo/Logs/Config/Metrics) + Chat Drawer，详见 [TechStack - 前端目录结构]
- 设计系统: Calm Futurism 主题，详见 [UI-UX] 全文

### 验收标准

1. 所有 API 路由实现并返回正确类型，Hono RPC 前端全类型推导。
2. WebSocket Hub 管理连接/订阅/通配符广播。
3. **Dashboard**: 系统状态 + 注意事项卡片 + 费用概览 (FlipNumber) + 活跃 Session + 事件流。
4. **Sessions**: 列表 (过滤/搜索) + 详情 (时间轴/minimap/ToolCallBlock/ContextPanel)。
5. **Memory**: 左右布局 / 语义搜索 (300ms debounce) / 类型过滤 / ConfidenceDots / TypeBadge / CodeMirror 编辑。
6. **Memo**: 全页 CodeMirror (5s auto-save / 冲突检测 / AI 编辑指示)。
7. **Logs**: 三类日志 Tab / 级别着色 / 时间范围 / 行展开 / 实时 tail。
8. **Config**: Models (Provider 卡片 + 降级链拖拽) / Scheduler (cron 双模式) / Fuse List。
9. **Metrics**: 堆叠条形图 + 模型分布 + 详细表格。
10. **Chat Drawer**: 360px push / Session 跨开关持久 / 流式响应 / 工具调用块。
11. **键盘导航**: j/k 移动 / Enter 选择 / Esc 关闭 / Cmd+K 全局搜索。

### 测试标准

- API 路由: 30+ 用例（每个路由成功+错误）
- WebSocket Hub: 5 用例
- 关键交互组件: 各 3+ 用例
- E2E: Dashboard 渲染 + Session 完整流程 + Config CRUD

**覆盖率目标**: API 70%+，前端组件 60%+

**依赖**: M6

---

## M8: 自修复 + 自更新 + 生产强化

**范围**: 跨包增强 — 完整自修复管线、版本管理、ChatGPT OAuth 完整流程、优雅关闭、错误处理审计、重试标准化

**新建/增强**:

- `packages/core/src/version/`: git.ts (auto-commit/tag/revert) + update.ts (自更新流程)
- `packages/health/src/repair.ts`: 增强为完整 diagnose → repair → verify，读 incidents/runbooks
- `packages/secrets/src/oauth.ts`: ChatGPT OAuth PKCE 完整流程
- `apps/server/src/shutdown.ts`: 优雅关闭

### 验收标准

1. **自修复管线**：注入错误 → Health 检测 → Agent 诊断(读日志) → 匹配 runbook → 执行修复 → 验证。
2. **Health fuse**: N 次修复失败 → lockdown + rollback + incident 记录 + 全通道通知。
3. **Git auto-commit**: AI 通过 Write/Edit 修改代码 → 自动 commit。
4. **Stable tag**: 重启后观察期（默认 5 分钟）无异常 → 打 `stable` tag。
5. **Rollback**: git revert 到 latest stable → 可重启。
6. **自更新完整流程**: 改代码 → commit → build:web → 健康检查 → Supervisor 重启 → 观察 → tag stable（详见 [TechStack - 自更新]）。
7. **ChatGPT OAuth**: UI 发起 → state+PKCE → 浏览器授权 → callback → token 入 vault → WS 通知（详见 [TechStack - ChatGPT OAuth 流程]）。
8. **凭证过期**: 401/403 → 标记失效 → `credential:expired` WS 事件 → UI 显示 → 降级链激活。
9. **优雅关闭**: 停止接收 → 等待工具完成 → flush 日志 → 释放锁 → 关闭。

### 测试标准

~50+ 新增用例：

- 自修复/git/update/oauth/shutdown 各 4-6 用例
- 集成: 注入损坏 config → 修复管线修复、OAuth mock 全流程、凭证过期降级
- E2E: 自更新完整流程、Supervisor recovery + rollback、复杂多步自主任务

**覆盖率目标**: 新代码 80%+，全项目 75%+

**依赖**: M6 + M7

---

## 测试体系

### 测试金字塔

```
         /  E2E  \           ~15 个场景 (M6-M8)
        /----------\
       / Integration \       ~30 个场景 (M2-M6)
      /----------------\
     /    Unit Tests     \   ~350+ 用例 (所有 M)
    /----------------------\
```

### 测试工具链

| 工具 | 用途 |
|------|------|
| `bun:test` | 单元测试 + 集成测试（Jest 兼容 API）|
| `tsc --noEmit` | 类型检查（`strict: true`）|
| `biome check` | 代码规范 |

### 覆盖率阶梯

| 层级 | 目标 | 说明 |
|------|------|------|
| 基础层 (shared, observe) | 90%+ | 所有包的地基，必须最高可靠性 |
| 安全+模型层 (secrets, model) | 85%+ | 部分分支仅在特定 API 响应时可达 |
| 记忆+核心层 (memory, core) | 80%+ | 真实 API 调用的错误路径难以完全覆盖 |
| 通道+调度+健康层 | 80%+ | 外部服务交互 |
| 主进程 (server, supervisor) | 75%+ | 环境相关分支多 |
| Web UI (API 路由) | 70%+ | |
| Web UI (前端组件) | 60%+ | UI 覆盖机械度量有限 |

### 每个里程碑的验证清单

每个里程碑交付前必须通过：

1. `bun run --check` — 类型检查零错误
2. `biome check` — 代码规范零错误
3. `bun test` — 所有测试通过
4. 覆盖率报告达到该里程碑目标
5. 演示场景手动执行通过
6. JSONL 日志 / metrics.db 可查询验证

---

## 参考文档索引

| 文档 | 里程碑引用 | 核心作用 |
|------|-----------|---------|
| [TechStack] | 所有 M | Monorepo 结构、包依赖、类型定义、接口规范 |
| [Architecture] | M3-M8 | 系统行为契约：Session 生命周期、tool-use loop、安全策略、自修复 |
| [ContextEngineering] | M4, M8 | XML System Prompt 结构、上下文预算、压缩策略、排队消息格式 |
| [UI-UX] | M7 | 页面/组件/交互/动画的完整视觉规格 |
