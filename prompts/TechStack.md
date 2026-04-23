# ZeRo OS 技术栈与框架

本文档基于 ZeRo OS 架构设计和 UI/UX 设计规范，定义系统的技术选型、模块边界和实现框架。

---

## 总览

```
语言:        TypeScript (全栈)
运行时:      Bun
平台:        macOS (首要且唯一目标平台)
包管理:      bun (内置 workspace)
构建:        后端免构建（Bun 原生跑 TS） + Vite (前端)
```

选择 TypeScript 全栈的理由：AI Agent 系统的核心是 LLM API 调用、JSON 处理、流式输出——TypeScript 生态在这些领域最成熟。前后端共享类型定义减少序列化边界的错误。社区中 AI SDK（Anthropic SDK、OpenAI SDK）均以 TypeScript 为一等公民。

选择 Bun 而非 Node.js 的理由：

1. **内置 SQLite**（`bun:sqlite`）——ZeRo OS 的日志聚合、Metrics、Tag 索引全靠 SQLite，Bun 内置意味着去掉 `better-sqlite3` 这个最重的 native addon，消除编译链故障点。
2. **原生跑 TypeScript**——后端不需要构建步骤。AI 自我修改代码后可以直接 `bun run src/main.ts` 验证，跳过编译环节，缩短"改代码→验证→重启"的循环。
3. **启动速度快**——Supervisor 重启主进程时，启动越快健康检查越早完成。
4. **内置 Shell API**（`Bun.$`）——Bash 工具的命令执行不再需要 `execa`。
5. **内置 ID 生成**（`Bun.randomUUIDv7()`）——不再需要 `nanoid`。

---

## Monorepo 结构

```
zero-os/
├── package.json                  # bun workspace 根
├── bunfig.toml                   # Bun 配置
├── tsconfig.base.json            # 共享 TS 配置
│
├── packages/
│   ├── core/                     # 核心运行时（Session、Agent、Tool 注册）
│   │   ├── src/
│   │   │   ├── session/          #   Session 生命周期管理
│   │   │   ├── agent/            #   Agent 执行引擎（含排队消息注入）
│   │   │   ├── tool/             #   Tool 基类 + 6 个内置工具（Read, Write, Edit, Bash, Fetch, Task）
│   │   │   ├── task/             #   SubAgent 编排器
│   │   │   ├── config/           #   config.yaml 解析与校验
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── model/                    # 模型层（Router + Provider Adapter）
│   │   ├── src/
│   │   │   ├── router.ts         #   Model Router（切换、降级链）
│   │   │   ├── registry.ts       #   Model Registry 解析
│   │   │   ├── adapters/
│   │   │   │   ├── base.ts       #     统一接口定义
│   │   │   │   ├── anthropic.ts  #     Anthropic Messages API
│   │   │   │   ├── openai-chat.ts#     OpenAI Chat Completions
│   │   │   │   └── openai-resp.ts#     OpenAI Responses API
│   │   │   └── stream.ts         #   流式输出统一处理
│   │   └── package.json
│   │
│   ├── memory/                   # 记忆模块
│   │   ├── src/
│   │   │   ├── store.ts          #   Markdown CRUD + Frontmatter 解析
│   │   │   ├── index.ts          #   memory.md 索引维护
│   │   │   ├── retrieval.ts      #   记忆检索（Embedding + Tag）
│   │   │   ├── embedding.ts      #   向量化 + 索引
│   │   │   ├── write.ts          #   写入管线（Path A / Path B 路由）
│   │   │   ├── write-intent.ts   #   写入意图检测（框架层拦截）
│   │   │   ├── dedup.ts          #   跨 Session 去重（三级阈值）
│   │   │   ├── classifier.ts     #   事件分类器（确定性 + 模型）
│   │   │   └── lifecycle.ts      #   记忆整理、归档、冲突解决、Session 结束流
│   │   └── package.json
│   │
│   ├── observe/                  # 观测性
│   │   ├── src/
│   │   │   ├── observability-store.ts #   事件流 + trace 投影视图存取
│   │   │   ├── metrics.ts        #   SQLite 聚合
│   │   │   ├── trace.ts          #   Session Trace 持久化与导出
│   │   │   ├── trace-projections.ts # trace -> requests/snapshots/closures/decisions 投影
│   │   │   └── secret-filter.ts  #   输出过滤（密钥脱敏）
│   │   └── package.json
│   │
│   ├── secrets/                  # 保密箱
│   │   ├── src/
│   │   │   ├── vault.ts          #   加密/解密 secrets.enc
│   │   │   ├── keychain.ts       #   macOS Keychain 交互
│   │   │   ├── oauth.ts          #   OAuth 流程管理（ChatGPT OAuth 回调处理）
│   │   │   └── filter.ts         #   全局输出过滤器
│   │   └── package.json
│   │
│   ├── channel/                  # Channel 抽象 + 内置实现（源码管理）
│   │   ├── src/                 # AI 自建的新 Channel 放在 .zero/channels/（运行时扩展）
│   │   │   ├── base.ts           #   Channel 接口定义
│   │   │   ├── feishu/           #   飞书机器人
│   │   │   ├── telegram/         #   Telegram Bot
│   │   │   └── web/              #   Web Channel（Chat Drawer 后端）
│   │   └── package.json
│   │
│   ├── scheduler/                # 定时任务
│   │   ├── src/
│   │   │   ├── cron.ts           #   crontab 管理
│   │   │   ├── runner.ts         #   触发 Session 创建
│   │   │   └── policy.ts         #   重叠策略、misfire 处理
│   │   └── package.json
│   │
│   ├── health/                   # 主进程内部的健康管理
│   │   ├── src/
│   │   │   ├── heartbeat.ts      #   心跳写入（主进程活着时持续写入）
│   │   │   ├── repair.ts         #   诊断-修复-验证流程（主进程内部自修复）
│   │   │   ├── fuse.ts           #   熔断机制
│   │   │   └── launchd.ts        #   LaunchAgent plist 生成（安装时用）
│   │   └── package.json
│   │
│   └── shared/                   # 共享类型和工具函数
│       ├── src/
│       │   ├── types/            #   全局类型定义
│       │   │   ├── session.ts
│       │   │   ├── message.ts
│       │   │   ├── tool.ts
│       │   │   ├── memory.ts
│       │   │   ├── config.ts
│       │   │   └── index.ts
│       │   ├── utils/
│       │   │   ├── id.ts         #   ID 生成（Bun.randomUUIDv7）
│       │   │   ├── time.ts       #   时间处理
│       │   │   ├── yaml.ts       #   YAML 读写
│       │   │   └── lock.ts       #   文件锁
│       │   └── index.ts
│       └── package.json
│
├── apps/
│   ├── server/                   # 主进程（入口）
│   │   ├── src/
│   │   │   ├── main.ts           #   启动流程：解密→加载配置→启动服务
│   │   │   ├── bus.ts            #   全局事件总线
│   │   │   └── cli.ts            #   命令行入口
│   │   └── package.json
│   │
│   ├── web/                      # Web UI
│   │   ├── src/
│   │   │   ├── api/              #   Hono API 路由
│   │   │   ├── ws/               #   WebSocket 推送
│   │   │   ├── app/              #   React 前端
│   │   │   └── server.ts         #   Hono 服务 + 静态资源
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   └── supervisor/               # Supervisor 独立进程（极简看门狗）
│       ├── src/
│       │   └── main.ts           #   心跳检测 + 重启主进程 + 熔断回滚
│       │                         #   不依赖任何内部包，独立运行
│       └── package.json
│
└── .zero/                        # 运行时数据目录（.gitignore 部分条目）
```

### 命名规范（Naming Convention）

本节是全项目命名的唯一权威源。Architecture 和 UI-UX 文档中的示例均应与此对齐。

**代码层（TypeScript）**：camelCase

```typescript
interface TokenUsage {
  input: number
  output: number
  cacheWrite?: number
  cacheRead?: number
  reasoning?: number
}
```

**持久化层（JSONL / YAML / SQLite）**：snake_case

```jsonl
{ "input": 3200, "output": 1800, "cache_write": 0, "cache_read": 800, "reasoning": 0 }
```

序列化边界处做自动转换（写入时 camelCase → snake_case，读取时反向）。两层命名一一对应，不允许出现一层有而另一层没有的字段。

**API 路由**：所有 HTTP API 路径以 `/api` 为前缀，路径用 kebab-case：

```
/api/sessions
/api/sessions/:id
/api/memory/search
/api/metrics/cost
/api/memo
/api/config/providers
/api/config/schedules
/api/config/fuse-list
```

**WebSocket 事件**：`topic:action` 格式，全小写：

```
session:update, tool:call, model:switch, credential:expired, oauth:success, message:queued, notification
```

### 包间依赖关系

以下用 `→` 表示"依赖"（A → B 表示 A 依赖 B）：

```
shared          ← 所有包都依赖（基础类型和工具函数）

core            → shared, model, memory, observe, secrets
                  （运行时引擎，需要调用模型、检索记忆、写日志、读密钥）

model           → shared, observe, secrets
                  （调用 LLM API，需要日志记录和 API Key）

memory          → shared, observe
                  （记忆读写需要日志记录）

observe         → shared
                  （纯工具层，只依赖基础类型）

secrets         → shared
                  （纯工具层）

channel         → shared, core
                  （接收消息后创建/复用 Session）

scheduler       → shared, core
                  （触发时创建 Session）

health          → shared
                  （主进程内部的心跳写入和修复编排，不依赖 core）

apps/server     → core, channel, scheduler, health
                  （主进程，组装所有包）

apps/web        → shared
                  （Web UI，通过 HTTP/WS 与主进程通信，不直接依赖 core）

apps/supervisor → 无内部依赖
                  （独立轻量进程，只做心跳检测和重启）
```

---

## 核心依赖

### 运行时 & 构建

| 类别 | 选型 | 版本 | 说明 |
|------|------|------|------|
| 运行时 | Bun | 1.2+ | 内置 SQLite、Shell API、原生 TS 执行 |
| 包管理 | bun | 内置 | workspace 协议，安装速度极快 |
| 前端构建 | Vite | 6.x | 开发热更新，生产打包（后端免构建） |
| 类型检查 | TypeScript | 5.7+ | `strict: true`，`bun run --check` 或 `tsc --noEmit` |
| 代码规范 | Biome | 1.x | 替代 ESLint + Prettier，速度快 |
| 测试 | `bun:test` | 内置 | Jest 兼容 API，无需额外安装 |

### AI / LLM

| 类别 | 选型 | 说明 |
|------|------|------|
| Anthropic SDK | `@anthropic-ai/sdk` | Messages API，原生流式 + Tool Use |
| OpenAI SDK | `openai` | Chat Completions + Responses API |
| 流式处理 | 各 SDK 原生 | Anthropic 的 `stream()` / OpenAI 的 `stream: true` |
| Token 计数 | `tiktoken`（OpenAI） + Anthropic API 返回值 | 预估上下文占用，触发压缩 |
| Embedding | OpenAI `text-embedding-3-small` | 记忆向量化，1536 维 |

**不用 LangChain / Vercel AI SDK 的理由**：ZeRo OS 的 Provider Adapter 只需适配三种协议（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses），抽象层极薄。引入框架会增加黑盒行为，干扰调试和自我修复。直接使用官方 SDK 对协议的控制力最强，也最容易做输出过滤和日志注入。

### 存储

| 类别 | 选型 | 说明 |
|------|------|------|
| 结构化存储 | `bun:sqlite` | Bun 内置，同步 API，零 native addon |
| 向量索引 | `vectra`（或 `hnswlib-node`） | 本地 HNSW 向量索引，无需外部服务 |
| YAML | `yaml`（`yaml` npm 包） | config.yaml 解析，支持 YAML 1.2 |
| Markdown Frontmatter | `gray-matter` | 记忆文件的元数据解析 |
| 文件锁 | `proper-lockfile` | 跨进程文件锁，Write/Edit/Memo 并发安全 |
| KV 缓存 | 内存 `Map` + `bun:sqlite` | 热数据内存缓存，持久化到 SQLite |

**为什么不用 PostgreSQL / Redis**：ZeRo OS 是单机系统，SQLite 的性能绰绰有余（百万级 JSONL 查询 < 50ms），零运维成本。向量检索用本地 HNSW，记忆量级（千条）远不需要 Pinecone 或 pgvector。

### 加密

| 类别 | 选型 | 说明 |
|------|------|------|
| AES 加密 | `node:crypto`（Bun 兼容） | AES-256-GCM，加密 `secrets.enc` |
| macOS Keychain | `security` CLI 命令（通过 `Bun.$`） | 读写主密钥，避免原生绑定的兼容性问题 |

使用 macOS `security` 命令行工具而非 `node-keytar` 等原生绑定，原因是：减少 native addon 依赖、AI 自我修复时更容易理解和排查、`security` 命令在所有 macOS 版本上可用。

```typescript
// keychain.ts 核心实现
const SERVICE = 'com.zero-os.vault'
const ACCOUNT = 'master-key'

export async function getMasterKey(): Promise<Buffer> {
  const result = await Bun.$`security find-generic-password -s ${SERVICE} -a ${ACCOUNT} -w`.text()
  return Buffer.from(result.trim(), 'base64')
}

export async function setMasterKey(key: Buffer): Promise<void> {
  const encoded = key.toString('base64')
  await Bun.$`security add-generic-password -s ${SERVICE} -a ${ACCOUNT} -w ${encoded} -U`
}
```

### 系统交互

| 类别 | 选型 | 说明 |
|------|------|------|
| 子进程 / Shell | `Bun.$` | Bun 内置 Shell API，tagged template，替代 `execa` |
| 文件监听 | `chokidar` | 监听 `.zero/` 目录变更，触发 UI 实时更新 |
| 网页内容提取 | `@mozilla/readability` + `turndown` | Fetch 工具的 HTML → Markdown 转换（readability 提取正文，turndown 转 Markdown） |
| 浏览器自动化 | `agent-browser`（CDP） | Browser Skill 的底层驱动，通过 CDP 连接真实 Chrome（非 Playwright 无头） |
| Git 操作 | `simple-git` | 版本管理、自动 commit、回滚 |
| Cron 解析 | `cron-parser` | 解析 cron 表达式，计算下次执行时间 |
| 系统 Cron | `crontab` CLI | Scheduler 直接操作系统 crontab |

### Channel SDK

| Channel | 依赖 | 说明 |
|---------|------|------|
| 飞书 | `@larksuiteoapi/node-sdk` | 官方 SDK，事件订阅 + 消息发送 |
| Telegram | `telegraf` | 成熟的 Telegram Bot 框架 |
| Web | 内置（Hono WebSocket） | Chat Drawer 后端，不需额外依赖 |

---

## Web UI 技术栈

### 后端 API

| 类别 | 选型 | 说明 |
|------|------|------|
| HTTP 框架 | Hono | 极轻量，类型安全，内置 WebSocket 支持 |
| 序列化 | Hono RPC（`hc`） | 前端类型安全的 API 调用，无需 codegen |
| WebSocket | `hono/ws` | 实时推送：Session 状态、工具调用、事件流 |
| 静态资源 | `hono/serve-static` | 生产模式直接 serve Vite 构建产物 |

Hono RPC 消除了前后端之间的类型断层。API 路由定义即类型合约，前端通过 `hc<AppType>` 获得完整的路径、参数、响应类型推导：

```typescript
// apps/web/src/api/routes.ts
import { Hono } from 'hono'
import type { Session, Memory } from '@zero-os/shared'

const app = new Hono()
  .get('/api/sessions', async (c) => {
    const sessions: Session[] = await sessionStore.listActive()
    return c.json(sessions)
  })
  .get('/api/sessions/:id', async (c) => {
    const session = await sessionStore.get(c.req.param('id'))
    return c.json(session)
  })
  .get('/api/memory/search', async (c) => {
    const results: Memory[] = await memory.search(c.req.query('q') ?? '')
    return c.json(results)
  })
  .get('/api/metrics/cost', async (c) => {
    const range = c.req.query('range') ?? '7d'
    return c.json(await metrics.costByModel(range))
  })
  .put('/api/memo', async (c) => {
    await memo.update(await c.req.text())
    return c.json({ ok: true })
  })

  // --- Config CRUD ---
  // Models
  .get('/api/config/providers', ...)
  .post('/api/config/providers', ...)              // 添加 Provider
  .put('/api/config/providers/:name', ...)         // 编辑 Provider
  .delete('/api/config/providers/:name', ...)      // 删除 Provider
  .post('/api/config/providers/:name/models', ...) // 添加模型
  .put('/api/config/providers/:name/models/:alias', ...)    // 编辑模型
  .delete('/api/config/providers/:name/models/:alias', ...) // 删除模型
  .put('/api/config/active-model', ...)            // 切换活跃模型
  .put('/api/config/fallback-chain', ...)          // 更新降级链
  .get('/api/config/health-check', ...)            // Provider 健康检查

  // Scheduler
  .get('/api/config/schedules', ...)
  .post('/api/config/schedules', ...)              // 添加定时任务
  .put('/api/config/schedules/:name', ...)         // 编辑定时任务
  .delete('/api/config/schedules/:name', ...)      // 删除定时任务
  .put('/api/config/schedules/:name/toggle', ...)  // 启用/停用
  .post('/api/config/schedules/:name/run', ...)    // 立即执行

  // Fuse List
  .get('/api/config/fuse-list', ...)
  .post('/api/config/fuse-list', ...)              // 添加规则
  .put('/api/config/fuse-list/:index', ...)        // 编辑规则
  .delete('/api/config/fuse-list/:index', ...)     // 删除规则

  // OAuth
  .get('/api/oauth/chatgpt/authorize', ...)        // 发起 ChatGPT OAuth，返回授权 URL
  .get('/api/oauth/chatgpt/callback', ...)         // ChatGPT OAuth 回调，接收 Token

export type AppType = typeof app
```

```typescript
// 前端调用（完整类型推导，无 codegen）
import { hc } from 'hono/client'
import type { AppType } from '../api/routes'

const client = hc<AppType>('/')
const sessions = await client.api.sessions.$get()
// sessions 的类型自动推导为 Session[]
```

### 前端

| 类别 | 选型 | 说明 |
|------|------|------|
| UI 框架 | React 19 | 社区生态最强，CodeMirror/recharts 集成最好 |
| 样式 | Tailwind CSS 4 | 与 UI/UX 设计规范的 utility-first 风格一致 |
| 路由 | TanStack Router | 类型安全路由，文件系统路由约定 |
| 状态管理 | Zustand | 轻量，适合中等复杂度 |
| 数据获取 | TanStack Query | 缓存 + 自动刷新 + WebSocket 集成 |
| 图表 | recharts | UI/UX 文档指定，React 原生 |
| Markdown 编辑 | CodeMirror 6 | Memo 页面 + Memory 编辑模式 |
| Markdown 渲染 | `react-markdown` + `remark-gfm` | Memory 详情面板的内容渲染 |
| 字体 | Geist + Geist Mono | UI/UX 文档指定 |
| 图标 | Lucide React | 线条风格，和 Calm Futurism 调性匹配 |
| 虚拟列表 | TanStack Virtual | Memory 列表、Logs 表格的大量数据渲染 |

### 前端目录结构

```
apps/web/src/app/
├── components/
│   ├── ui/                     # 基础组件（Button、Card、Badge、Input...）
│   ├── layout/
│   │   ├── Sidebar.tsx         #   侧边栏（全局共享）
│   │   ├── StatusBar.tsx       #   系统状态微缩版
│   │   └── ChatDrawer.tsx      #   Chat Drawer（右侧滑出）
│   ├── session/
│   │   ├── SessionList.tsx
│   │   ├── SessionTimeline.tsx #   时间线主体
│   │   ├── SessionMinimap.tsx  #   时间轴 minimap
│   │   ├── ToolCallBlock.tsx   #   工具调用块
│   │   └── ContextPanel.tsx    #   右侧上下文面板
│   ├── memory/
│   │   ├── MemoryList.tsx
│   │   ├── MemoryDetail.tsx
│   │   ├── MemoryEditor.tsx    #   编辑模式
│   │   ├── ConfidenceDots.tsx  #   Confidence 指示器
│   │   └── TypeBadge.tsx       #   类型标签（统一颜色）
│   ├── dashboard/
│   │   ├── SystemStatus.tsx
│   │   ├── AttentionCard.tsx   #   需要关注
│   │   ├── CostOverview.tsx    #   费用概览
│   │   ├── ActiveSessions.tsx
│   │   └── ActivityFeed.tsx    #   事件流
│   ├── metrics/
│   │   ├── CostChart.tsx       #   堆叠条形图
│   │   ├── TokenChart.tsx
│   │   ├── ModelDistribution.tsx
│   │   └── DetailTable.tsx
│   ├── config/
│   │   ├── ProviderCard.tsx    #   Provider 卡片（展示 + 编辑）
│   │   ├── ModelRow.tsx        #   模型行（展示 + 编辑）
│   │   ├── AuthTypeSelector.tsx #  认证方式选择（API Key / OAuth Token / ChatGPT OAuth）
│   │   ├── FallbackChainEditor.tsx  # 降级链拖拽排序
│   │   ├── ScheduleCard.tsx    #   定时任务卡片（展示 + 编辑）
│   │   ├── CronInput.tsx       #   双模式 Cron 输入（可视化 + 手动）
│   │   ├── FuseListItem.tsx    #   熔断规则行
│   │   └── ConfigStatusBar.tsx #   底部保存状态栏
│   └── shared/
│       ├── FlipNumber.tsx      #   数字翻牌动画
│       ├── PulseDot.tsx        #   脉搏动画
│       └── MarkdownRenderer.tsx
├── routes/
│   ├── __root.tsx              # 根布局（Sidebar + 主内容区）
│   ├── dashboard.tsx
│   ├── sessions/
│   │   ├── index.tsx           #   列表视图
│   │   └── $sessionId.tsx      #   详情页
│   ├── memory.tsx
│   ├── memo.tsx
│   ├── logs.tsx
│   ├── config.tsx
│   └── metrics.tsx
├── stores/
│   ├── session.ts              # 活跃 Session 状态
│   ├── ws.ts                   # WebSocket 连接管理
│   └── ui.ts                   # UI 状态（Drawer 开关、当前页等）
├── hooks/
│   ├── useWebSocket.ts         # WebSocket 订阅
│   ├── useRealtimeQuery.ts     # TanStack Query + WS 自动刷新
│   └── useKeyboard.ts          # 键盘导航
├── lib/
│   ├── api.ts                  # Hono RPC client 初始化
│   ├── format.ts               # 数字格式化、时间格式化
│   └── colors.ts               # 类型→颜色映射（全站统一）
├── styles/
│   └── globals.css             # Tailwind 入口 + 自定义 CSS 变量
└── main.tsx
```

---

## 实时通信架构

Web UI 的实时性是 Dashboard 和 Session 回放的核心。架构设计围绕一个全局事件总线展开。

```
┌─────────────────────────────────────────────────────────┐
│                     主进程                                │
│                                                          │
│  Session 执行引擎                                        │
│    │                                                     │
│    ├── Tool 调用 ──→ bus.emit('tool:call', {...})        │
│    ├── 模型切换 ──→ bus.emit('model:switch', {...})      │
│    ├── 通知 ────→ bus.emit('notification', {...})        │
│    └── 状态变更 ──→ bus.emit('session:update', {...})    │
│                                                          │
│  观测模块                                                │
│    └── JSONL 写入时同步 emit 对应事件                     │
│                                                          │
│  全局事件总线（EventEmitter）                             │
│    │                                                     │
│    ├──→ WebSocket Hub ──→ 所有连接的 Web UI 客户端       │
│    ├──→ Observability Store（事件流 + trace 投影）        │
│    └──→ Metrics Aggregator（定期从 JSONL 聚合到 SQLite） │
└─────────────────────────────────────────────────────────┘
```

### WebSocket 协议

客户端连接后发送订阅消息，服务端按需推送：

```typescript
// 客户端 → 服务端：订阅
{ "type": "subscribe", "topics": ["session:*", "tool:*", "metrics:cost"] }

// 服务端 → 客户端：事件
{ "type": "event", "topic": "tool:call", "data": { "sessionId": "sess_001", "tool": "bash", "input": "ls -la", "status": "success", "duration_ms": 45 } }

// 服务端 → 客户端：Session 流式输出
{ "type": "stream", "sessionId": "sess_001", "delta": "好的，我来看一下..." }
```

使用主题通配符（`session:*` 匹配所有 Session 事件）减少订阅管理复杂度。Dashboard 订阅全局事件，Session 详情页订阅特定 Session 事件。

---

## 核心模块设计

### Supervisor 与 Health 的职责划分

系统的"保活与自修复"能力分布在两个独立单元中：

**`apps/supervisor`（独立进程，看门狗）**

极简 Bun 脚本，不依赖 monorepo 中的任何包。职责：

1. 每 20 秒检查主进程心跳文件的更新时间。
2. 超过 50 秒未更新，判定主进程失活，执行重启。
3. 连续 N 次重启失败后触发熔断：回滚到最近 `stable` Tag，通知用户。

**`packages/health`（主进程内部模块）**

主进程活着时负责健康管理。职责：

1. **心跳写入**：每 10 秒写入心跳文件，供 Supervisor 检测。
2. **自修复编排**：主进程遇到错误时（如工具执行失败、依赖异常），编排诊断→修复→验证流程。
3. **熔断逻辑**：连续修复失败时锁定系统、写入 incident。
4. **LaunchAgent 生成**：安装时生成 plist 文件。

核心原则：**主进程挂了 → Supervisor 负责重启；主进程活着但遇到错误 → Health 模块自己处理**。两者不重叠。

### Provider Adapter 接口

三种协议适配器实现统一接口，支持三种认证方式（详见 [Architecture - 认证方式]）：

```typescript
// packages/model/src/adapters/base.ts

type AuthType = 'api_key' | 'oauth_token' | 'oauth_chatgpt'

interface ProviderConfig {
  name: string
  apiType: string
  baseUrl: string
  authType: AuthType
  credentialRef: string          // 保密箱中的凭证键名
}

interface CompletionRequest {
  messages: Message[]
  tools?: ToolDefinition[]
  system?: string
  stream: boolean
  maxTokens?: number
}

interface CompletionResponse {
  id: string
  content: ContentBlock[]        // text + tool_use 混合
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
  usage: TokenUsage
}

interface TokenUsage {
  input: number
  output: number
  cacheWrite?: number
  cacheRead?: number
  reasoning?: number           // reasoning 模型（o3、deepseek-r1 等）的推理 token
}

interface StreamEvent {
  type: 'text_delta' | 'tool_use_start' | 'tool_use_delta' | 'tool_use_end' | 'done'
  data: unknown
}

interface ProviderAdapter {
  readonly config: ProviderConfig

  complete(req: CompletionRequest): Promise<CompletionResponse>

  stream(req: CompletionRequest): AsyncIterable<StreamEvent>

  // 检查 API 可达性（降级链用）。
  // 同时检测凭证有效性——401/403 视为凭证失效。
  healthCheck(): Promise<HealthCheckResult>
}

interface HealthCheckResult {
  reachable: boolean
  credentialValid: boolean      // 凭证是否有效（Token 过期 = false）
  error?: string
}
```

#### 认证处理

认证逻辑分为两个层面：Anthropic 协议在 SDK 客户端构造时处理，OpenAI 兼容协议通过 HTTP Header 注入。

```typescript
// packages/model/src/adapters/auth.ts

/** Anthropic OAuth Token 的 Beta 协议头（Anthropic API 要求） */
const ANTHROPIC_OAUTH_BETA_HEADERS: Record<string, string> = {
  'anthropic-beta': 'oauth-2025-04-20',
}

/** 根据 token 前缀判断是否为 Anthropic OAuth Token */
function isAnthropicOAuthToken(token: string): boolean {
  return token.startsWith('sk-ant-oat-')
}

/**
 * 创建 Anthropic SDK 客户端。
 *
 * OAuth Token 需要特殊处理：
 * 1. 使用 SDK 的 authToken 参数（而非 apiKey），SDK 自动发送 Authorization: Bearer 头
 * 2. 显式传入 apiKey: null，阻止 SDK 从 process.env.ANTHROPIC_API_KEY 自动读取
 *    （否则 SDK 会同时发送 x-api-key 和 Authorization: Bearer，导致认证冲突）
 * 3. 附加 Beta Headers
 */
function createAnthropicClient(config: ProviderConfig, credential: string): Anthropic {
  if (config.authType === 'oauth_token') {
    return new Anthropic({
      authToken: credential,
      apiKey: null,                           // 阻止 SDK 读取环境变量
      baseURL: config.baseUrl,
      defaultHeaders: ANTHROPIC_OAUTH_BETA_HEADERS,
    })
  }
  return new Anthropic({
    apiKey: credential,
    baseURL: config.baseUrl,
  })
}

/**
 * 为 OpenAI 兼容协议注入认证头。
 * Anthropic 协议不走此函数（由 SDK 在客户端构造时自动处理认证头）。
 */
function injectOpenAIAuth(headers: Headers, credential: string): void {
  headers.set('Authorization', `Bearer ${credential}`)
}
```

每个适配器负责：消息格式转换（统一格式 ↔ 厂商格式）、Tool Schema 转换（统一 JSON Schema ↔ 厂商格式）、认证处理（Anthropic 协议通过 `createAnthropicClient` 在 SDK 层处理，OpenAI 兼容协议通过 `injectOpenAIAuth` 注入头）、错误码映射、重试逻辑。当收到 401/403 响应时，标记凭证失效，触发 `credential:expired` 事件通知 Web UI 提示用户重新授权。

#### ChatGPT OAuth 流程

ChatGPT 官方支持 OAuth 授权。整个流程由 `packages/secrets/src/oauth.ts` 管理：

```
用户点击「通过 OAuth 登录」
       │
       ▼
后端 /api/oauth/chatgpt/authorize
  → 生成 state + PKCE code_verifier
  → 将 state 和 code_verifier 暂存内存
  → 返回授权 URL 给前端
       │
       ▼
前端打开新浏览器窗口/标签页
  → 用户在 ChatGPT 页面登录并授权
       │
       ▼
ChatGPT 回调到 /api/oauth/chatgpt/callback?code=xxx&state=yyy
  → 验证 state 匹配
  → 用 code + code_verifier 换取 access_token（+ refresh_token）
  → 存入保密箱（credential_ref = 用户指定的名称）
  → 关闭浏览器窗口，Web UI 收到 WebSocket 通知「OAuth 授权成功」
```

Token 刷新：如果 ChatGPT OAuth 返回了 `refresh_token`，系统在 `access_token` 过期前自动刷新。刷新失败则标记凭证失效，提示用户重新授权。

#### Anthropic OAuth Token

Anthropic OAuth Token 的获取方式在系统外完成（用户自行获取）。在 UI 上的输入方式和 API Key 完全一样（粘贴输入），但后端处理有本质区别：

**Token 格式与自动识别**

Anthropic OAuth Token 使用 `sk-ant-oat-` 前缀（API Key 使用 `sk-ant-api-` 前缀）。系统通过前缀自动识别凭证类型，用于内部断言和调试校验。用户在 UI 上选择的 `auth_type` 仍然是权威来源，前缀检测仅作辅助验证。

**SDK 参数差异**

OAuth Token 必须使用 Anthropic SDK 的 `authToken` 参数构造客户端（SDK 自动发送 `Authorization: Bearer` 头），而非 `apiKey` 参数（对应 `x-api-key` 头）。两者在 SDK 内部走完全不同的认证路径。

**Beta Headers**

Anthropic OAuth Token 请求必须附加协议级 Beta Header：

```typescript
const ANTHROPIC_OAUTH_BETA_HEADERS = {
  'anthropic-beta': 'oauth-2025-04-20',
}
```

不携带此 Header 的 OAuth Token 请求会被 Anthropic API 拒绝。

**环境变量隔离**

Anthropic SDK 构造函数在未显式传入 `apiKey` 时，会自动从 `process.env.ANTHROPIC_API_KEY` 读取。如果系统同时配置了 Anthropic API Key Provider 和 Anthropic OAuth Provider，环境中可能存在 `ANTHROPIC_API_KEY`，导致 SDK 同时发送 `x-api-key` 和 `Authorization: Bearer` 两个认证头，引发冲突。解决方式：构造 OAuth 客户端时显式传入 `apiKey: null`，阻止 SDK 读取环境变量（详见上方 `createAnthropicClient` 函数）。

**Token 生命周期**

系统不负责 Anthropic OAuth Token 的获取和刷新。Token 过期时通过健康检查发现（401），提示用户重新粘贴。

### Tool 基类

```typescript
// packages/core/src/tool/base.ts

interface ToolContext {
  sessionId: string
  workDir: string              // Agent 工作目录
  logger: Logger
  secretFilter: SecretFilter   // 输出过滤
}

interface ToolResult {
  success: boolean
  output: string
  outputSummary: string        // 写入日志的摘要
  artifacts?: string[]         // 产出文件路径
}

abstract class BaseTool {
  abstract name: string
  abstract description: string
  abstract parameters: JSONSchema

  // 熔断检查（Bash 工具覆写）
  protected async fuseCheck(input: unknown): Promise<void> {}

  // 执行前钩子（加锁等）
  protected async beforeExecute(ctx: ToolContext, input: unknown): Promise<void> {}

  // 实际执行
  protected abstract execute(ctx: ToolContext, input: unknown): Promise<ToolResult>

  // 执行后钩子（解锁、写日志）
  protected async afterExecute(ctx: ToolContext, result: ToolResult): Promise<void> {}

  // 对外暴露的唯一入口
  async run(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    await this.fuseCheck(input)
    await this.beforeExecute(ctx, input)
    const result = await this.execute(ctx, input)
    await this.afterExecute(ctx, result)
    return result
  }
}
```

6 个内置工具的锁策略在 `beforeExecute`/`afterExecute` 中实现：

| 工具 | 锁 |
|------|-----|
| Read | 无锁 |
| Write | `proper-lockfile` 按文件路径 |
| Edit | `proper-lockfile` 按文件路径 |
| Bash | 无锁（受熔断名单约束） |
| Fetch | 无锁，完全并发 |
| Task | 无锁（SubAgent 各自独立） |

### Session 生命周期

```typescript
// packages/core/src/session/session.ts

class Session {
  readonly id: string
  readonly source: 'feishu' | 'telegram' | 'scheduler' | 'web'
  private messages: Message[] = []
  private messageQueue: QueuedMessage[] = []  // 排队消息队列
  private busy = false                         // Agent 是否在 tool use loop 中
  private modelRouter: ModelRouter
  private agent: Agent
  private memoryRetriever: MemoryRetriever

  async handleUserMessage(content: string): Promise<void> {
    // 1. 命令解析（/new、/model 等）
    if (content.startsWith('/')) {
      return this.handleCommand(content)
    }

    // 2. Agent 正忙 → 消息入队
    if (this.busy) {
      this.messageQueue.push({
        content,
        receivedAt: new Date().toISOString(),
      })
      this.emit('message:queued', { sessionId: this.id, content })
      return
    }

    // 3. 记忆检索（独立单轮调用，不进入主上下文）
    const relevantMemories = await this.memoryRetriever.retrieve(
      content, this.agent.identityMemory
    )

    // 4. 组装上下文
    const context = this.buildContext(relevantMemories)

    // 5. Agent 循环（tool use loop）
    this.busy = true
    try {
      await this.agent.run(context, content)
    } finally {
      this.busy = false
    }
  }

  /** Agent 在 tool use loop 的回合间隙调用，获取并清空排队消息 */
  drainQueue(): QueuedMessage[] {
    const queued = [...this.messageQueue]
    this.messageQueue = []
    return queued
  }

  private buildContext(memories: Memory[]): AgentContext {
    return {
      systemPrompt: this.agent.systemPrompt,
      identityMemory: this.agent.identityMemory,
      retrievedMemories: memories,
      conversationHistory: this.messages,
      tools: this.agent.tools,
    }
  }
}

interface QueuedMessage {
  content: string
  receivedAt: string  // ISO 时间戳
}
```

Agent 的 tool use loop 在每次工具执行完毕后调用 `session.drainQueue()` 检查排队消息，有消息则按 [ContextEngineering - 排队消息注入] 的格式包装后注入 messages。
```

### SubAgent 编排

```typescript
// packages/core/src/tool/constants.ts
export const SUB_AGENT_BLOCKED_TOOLS = new Set([
  'spawn_agent',
  'wait_agent',
  'close_agent',
  'send_input',
])

// packages/core/src/tool/spawn-agent.ts
class SpawnAgentTool extends BaseTool {
  buildScopedRegistry(tools?: string[]): ToolRegistry {
    const scoped = new ToolRegistry()
    const source = tools ?? this.baseToolRegistry.list().map((tool) => tool.name)

    for (const toolName of source) {
      if (SUB_AGENT_BLOCKED_TOOLS.has(toolName)) continue
      const tool = this.baseToolRegistry.get(toolName)
      if (tool) scoped.register(tool)
    }

    return scoped
  }

  protected async execute(ctx: ToolContext, input: SpawnAgentInput): Promise<ToolResult> {
    const mode = input.mode ?? 'standard'
    const scopedRegistry = this.buildScopedRegistry(input.tools)
    const agent = new Agent(agentConfig, adapter, scopedRegistry, toolContext, agentObs)
    const agentContext = {
      systemPrompt: buildSubAgentPrompt(scopedRegistry.getDefinitions(), instruction, rolePrompt),
      conversationHistory: [],
      tools: scopedRegistry.getDefinitions(),
    }

    const spawnResult = ctx.agentControl.spawn(agent, agentContext, instruction, {
      mode,
      label,
    })

    return { success: true, output: JSON.stringify(spawnResult) }
  }
}
```

---

## 记忆检索实现

### 双通道检索

```typescript
// packages/memory/src/retrieval.ts

class MemoryRetriever {
  private vectorIndex: VectorIndex     // HNSW 向量索引
  private tagIndex: TagIndex           // SQLite tag 索引

  async retrieve(
    query: string,
    identityMemory: string,
    options: RetrievalOptions = {}
  ): Promise<Memory[]> {
    const { topN = 5, confidenceThreshold = 0.6 } = options

    // 1. 用便宜模型判断是否需要检索
    const needsRetrieval = await this.shouldRetrieve(query, identityMemory)
    if (!needsRetrieval) return []

    // 2. 向量语义检索
    const queryEmbedding = await this.embed(query)
    const semanticResults = await this.vectorIndex.search(queryEmbedding, topN * 2)

    // 3. Tag 精确过滤
    const filtered = semanticResults.filter(r =>
      r.status === 'verified' &&
      r.confidence >= confidenceThreshold
    )

    // 4. 返回 Top N
    return filtered.slice(0, topN)
  }
}
```

### Embedding 管线

```typescript
// packages/memory/src/embedding.ts

class EmbeddingPipeline {
  // 内容变更时增量更新向量
  async onMemoryUpdate(memory: Memory): Promise<void> {
    const text = this.memoryToText(memory)     // 标题 + 摘要 + tags
    const vector = await this.embed(text)
    await this.vectorIndex.upsert(memory.id, vector, {
      type: memory.type,
      status: memory.status,
      confidence: memory.confidence,
      tags: memory.tags,
    })
  }

  // 使用 OpenAI text-embedding-3-small
  private async embed(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    })
    return response.data[0].embedding
  }
}
```

向量索引存储在 `.zero/memory/vectors/` 下，使用 HNSW 算法。千条量级的记忆，检索延迟 < 10ms。

---

## 记忆写入实现

架构设计见 [Architecture - 记忆的写入]，上下文处理（Prompt、通知格式）见 [ContextEngineering - 记忆写入的上下文处理]。

### 写入管线核心

```typescript
// packages/memory/src/write.ts

/** 写入请求可指定的状态 */
type WriteStatus = 'draft' | 'verified'

/** 存储层的完整状态集（包含系统管理的状态） */
type MemoryStatus = WriteStatus | 'corrupted'

interface WriteRequest {
  path: 'A' | 'B'
  target: string           // Path A: 'global' | 'agent' | 'memo'，Path B: memory type
  operation?: 'append' | 'update' | 'remove'  // Path A 专用，默认 'append'
  content: string
  confidence: number
  status: WriteStatus         // 请求时可指定的状态
  sessionId: string
  agentName: string
  tags?: string[]
}

interface WriteResult {
  success: boolean
  memoryId: string
  action: 'created' | 'merged' | 'rejected'
  mergedWith?: string      // 合并时的目标记忆 ID
  capacityWarning?: boolean
}

class MemoryWriter {
  private store: MemoryStore
  private vectorIndex: VectorIndex
  private tagIndex: TagIndex
  private dedup: DedupChecker
  private lockManager: LockManager
  private logger: Logger

  async write(req: WriteRequest): Promise<WriteResult> {
    if (req.path === 'A') return this.writePathA(req)
    return this.writePathB(req)
  }

  private async writePathA(req: WriteRequest): Promise<WriteResult> {
    const filePath = this.resolvePathATarget(req.target, req.agentName)
    const operation = req.operation ?? 'append'
    const limit = PATH_A_LIMITS[req.target]

    // 文件锁内执行：读取 → 容量检查 → 写入（消除 TOCTOU 竞态）
    const release = await this.lockManager.acquire(filePath)
    try {
      const current = await this.store.read(filePath)

      // 模拟写入后的内容，计算写入后 token 数
      const projected = this.store.projectSection(current, req.content, req.agentName, operation)
      const projectedTokens = countTokens(projected)

      if (projectedTokens > limit) {
        return { success: false, memoryId: '', action: 'rejected', capacityWarning: true }
      }

      await this.store.applySection(filePath, projected)
      return {
        success: true,
        memoryId: filePath,
        action: 'created',
        capacityWarning: projectedTokens > limit * 0.9,
      }
    } finally {
      await release()
    }
  }

  private async writePathB(req: WriteRequest): Promise<WriteResult> {
    // 1. 去重检查
    const dedupResult = await this.dedup.check(req.content)

    if (dedupResult.action === 'duplicate' && dedupResult.existingId) {
      return this.mergeInto(dedupResult.existingId, req)
    }

    // 2. 事务性多层写入（先创建新记录拿到 ID）
    const result = await this.transactionalWrite(req)

    // 3. 如果判定为 related，建立双向链接（非致命：主记录已落地，关联失败不回滚主记录）
    if (dedupResult.action === 'related' && dedupResult.existingId && result.success) {
      try {
        await this.store.addRelatedBidirectional(dedupResult.existingId, result.memoryId)
        // addRelatedBidirectional 在同一事务中同时写入 A→B 和 B→A，
        // 失败时两边都不写入，避免产生单向半链接
      } catch (error) {
        // 关联失败是非致命错误——主记录已成功创建并索引化。
        // 记录日志供后续 memory_cleanup 任务补建关联，不向上层抛错。
        this.logger.warn('related link failed', { newId: result.memoryId,
          existingId: dedupResult.existingId, error })
      }
    }

    return result
  }
}

const PATH_A_LIMITS: Record<string, number> = {
  global: 1000,   // preferences/global.md
  agent: 2000,    // preferences/agents/{name}.md
  memo: 1500,     // memo.md
}
```

### 事务性多层写入

Path B 每次写入必须同时维护四层存储：Markdown 文件 + 向量索引 + Tag 索引 + memory.md 全局索引。任一层失败则尝试回滚。回滚本身也可能失败（磁盘故障等），此时标记记忆为 `corrupted`，由 `memory_cleanup` 定时任务修复。

```typescript
// packages/memory/src/write.ts — transactionalWrite

private async transactionalWrite(req: WriteRequest): Promise<WriteResult> {
  const memoryId = generateId(req.target)
  const filePath = `.zero/memory/${req.target}s/${memoryId}.md`
  const memory = this.buildMemoryEntry(memoryId, req)

  const rollback: (() => Promise<void>)[] = []

  try {
    // Layer 1: Markdown 文件
    await this.store.create(filePath, memory)
    rollback.push(() => this.store.delete(filePath))

    // Layer 2: 向量索引
    const text = `${memory.title}\n${memory.content}`
    const vector = await this.embed(text)
    await this.vectorIndex.upsert(memoryId, vector, {
      type: memory.type,
      status: memory.status,
      confidence: memory.confidence,
      tags: memory.tags,
      updatedAt: new Date().toISOString(),
    })
    rollback.push(() => this.vectorIndex.remove(memoryId))

    // Layer 3: Tag 索引
    await this.tagIndex.insert(memoryId, {
      type: memory.type,
      status: memory.status,
      confidence: memory.confidence,
      tags: memory.tags,
      sessionId: req.sessionId,
    })
    rollback.push(() => this.tagIndex.remove(memoryId))

    // Layer 4: memory.md 全局索引
    // 先注册回滚（在更新之前），防止 updateIndex 部分写入后抛错时回滚函数未注册
    rollback.push(() => this.removeFromIndex(memoryId))
    await this.updateIndex(memory)

    return { success: true, memoryId, action: 'created' }
  } catch (error) {
    // 尝试回滚所有已完成的操作（按逆序）
    let rollbackFailed = false
    for (const fn of rollback.reverse()) {
      try {
        await fn()
      } catch (rollbackError) {
        rollbackFailed = true
        this.logger.error('rollback failed', { memoryId, rollbackError })
      }
    }

    // 回滚本身失败 → 标记为 corrupted，由 memory_cleanup 修复
    if (rollbackFailed) {
      try {
        await this.store.markCorrupted(memoryId)
      } catch (markError) {
        // 标记也失败：记录到日志，这是最后的信号保留手段
        this.logger.error('markCorrupted failed, manual intervention needed',
          { memoryId, markError })
      }
    }

    throw error
  }
}
```

### 跨 Session 去重

```typescript
// packages/memory/src/dedup.ts

interface DedupResult {
  action: 'duplicate' | 'related' | 'different'
  existingId?: string
  similarity: number
}

class DedupChecker {
  private vectorIndex: VectorIndex

  async check(content: string): Promise<DedupResult> {
    const embedding = await this.embed(content)
    const nearest = await this.vectorIndex.searchNearest(embedding, 3)

    if (!nearest || nearest.length === 0) {
      return { action: 'different', similarity: 0 }
    }

    const top = nearest[0]

    // 三级阈值判断
    if (top.score > 0.98) {
      return { action: 'duplicate', existingId: top.id, similarity: top.score }
    }

    if (top.score > 0.85) {
      // 灰色区间：便宜模型判断
      const existing = await this.store.read(top.id)
      const judgment = await this.modelJudge(content, existing.content)
      return {
        action: judgment,
        existingId: judgment !== 'different' ? top.id : undefined,
        similarity: top.score,
      }
    }

    return { action: 'different', similarity: top.score }
  }

  /** 便宜模型判断两条记忆的关系 */
  private async modelJudge(
    newContent: string,
    existingContent: string,
  ): Promise<'duplicate' | 'related' | 'different'> {
    const result = await this.cheapModel.complete({
      system: `比较两条记录，判断关系：
- duplicate: 同一件事的重复记录，应合并
- related: 相关但不同的事件，应建立关联
- different: 不相关
返回 JSON: {"relation": "duplicate" | "related" | "different"}`,
      messages: [{
        role: 'user',
        content: `记录A:\n${existingContent}\n\n记录B:\n${newContent}`,
      }],
    })
    return JSON.parse(result).relation
  }
}
```

合并逻辑：重复出现的信息 confidence +0.1，满足自动验证条件（`confidence >= 0.7` 且 `>= 2` 个不同 Session 确认）时 status 自动升级为 `verified`。

```typescript
// packages/memory/src/write.ts — mergeInto

private async mergeInto(
  existingId: string,
  incoming: WriteRequest,
): Promise<WriteResult> {
  const existing = await this.store.read(existingId)

  // 合并内容（便宜模型去重 + 补充）
  const mergedContent = await this.cheapModel.complete({
    system: `合并两条相似的记忆记录。保留所有不重复的信息，去除冗余。输出不超过 400 tokens。`,
    messages: [{
      role: 'user',
      content: `已有记录:\n${existing.content}\n\n新记录:\n${incoming.content}`,
    }],
  })

  // confidence 升级：取两者较大值再 +0.1（Architecture - 冲突解决）
  const baseConfidence = Math.max(existing.confidence, incoming.confidence)
  const newConfidence = Math.min(baseConfidence + 0.1, 1.0)
  const sessionIds = [...new Set([...existing.sessionIds, incoming.sessionId])]

  // 自动验证判定
  const newStatus = (
    newConfidence >= 0.7 && sessionIds.length >= 2
  ) ? 'verified' : existing.status

  // 合并目标固定为 existingId（保持 ID 稳定，已有链接和引用不中断）。
  // confidence 通过上面的 Math.max 取两者较大值再 +0.1。
  // 内容由模型合并，不偏向任何一方。

  const updated = {
    ...existing,
    content: mergedContent,
    confidence: newConfidence,
    status: newStatus,
    sessionIds,
    tags: [...new Set([...existing.tags, ...(incoming.tags ?? [])])],
    mergeHistory: [
      ...existing.mergeHistory,
      { sessionId: incoming.sessionId, mergedAt: new Date().toISOString(),
        confidenceBefore: existing.confidence, confidenceAfter: newConfidence },
    ],
  }

  // 事务性多层更新（与 transactionalWrite 对称的回滚保证）
  const snapshot = await this.store.snapshot(existingId) // 保存更新前的快照
  try {
    await this.store.update(existingId, updated)
    const vector = await this.embed(`${updated.title}\n${updated.content}`)
    await this.vectorIndex.upsert(existingId, vector, {
      type: updated.type, status: updated.status,
      confidence: updated.confidence, tags: updated.tags,
    })
    await this.tagIndex.update(existingId, {
      status: updated.status, confidence: updated.confidence, tags: updated.tags,
    })
    await this.updateIndex(updated)
  } catch (error) {
    // 尝试恢复更新前的快照（覆盖全部四层）
    let rollbackFailed = false
    for (const fn of [
      () => this.store.restore(existingId, snapshot),
      () => this.vectorIndex.upsert(existingId, snapshot.vector, snapshot.metadata),
      () => this.tagIndex.update(existingId, snapshot.tagMetadata),
      () => this.restoreIndex(existingId, snapshot.indexEntry),
    ]) {
      try { await fn() } catch (e) {
        rollbackFailed = true
        this.logger.error('merge rollback failed', { existingId, error: e })
      }
    }
    if (rollbackFailed) {
      try {
        await this.store.markCorrupted(existingId)
      } catch (markError) {
        this.logger.error('markCorrupted failed, manual intervention needed',
          { existingId, markError })
      }
    }
    throw error
  }

  return { success: true, memoryId: existingId, action: 'merged', mergedWith: existingId }
}
```

### 事件分类器

```typescript
// packages/memory/src/classifier.ts

/** 单路径事件类型（可由 EventClassifier 分类）。
 *  跨路径事件（session_end / session_interrupt）不在此类型中，
 *  由 SessionLifecycle 直接编排，不经过分类器。 */
type EventType =
  | 'task_status_change' | 'user_correction' | 'user_preference'
  | 'error_recurring' | 'fix_verified' | 'architecture_choice'
  | 'user_request' | 'agent_discovery'

interface ClassifyResult {
  path: 'A' | 'B'
  target: string
}

class EventClassifier {
  /**
   * 确定性路由表，无需模型调用。
   * 注意：session_end / session_interrupt 不经过此分类器，
   * 由 SessionLifecycle 直接编排跨路径写入（既有 A 又有 B）。
   */
  private static DETERMINISTIC: Record<string, ClassifyResult> = {
    task_status_change:  { path: 'A', target: 'memo' },
    user_correction:     { path: 'A', target: 'agent' },
    user_preference:     { path: 'A', target: 'global' },
    error_recurring:     { path: 'B', target: 'incident' },
    fix_verified:        { path: 'B', target: 'runbook' },
    architecture_choice: { path: 'B', target: 'decision' },
  }

  /**
   * 分类单路径事件。返回 A 或 B。
   * 跨路径事件（session_end / session_interrupt）不走此方法，
   * 由 SessionLifecycle.onSessionEnd() 自行拆解为多次 A/B 写入。
   */
  async classify(eventType: EventType, content: string, agentName: string): Promise<ClassifyResult> {
    const deterministic = EventClassifier.DETERMINISTIC[eventType]
    if (deterministic) return deterministic

    // 模糊事件：便宜模型单轮调用
    // Prompt 定义见 [ContextEngineering - 事件分类 Prompt]
    return this.modelClassify(eventType, content, agentName)
  }
}
```

### 框架层写入拦截

```typescript
// packages/memory/src/write-intent.ts

class WriteIntentDetector {
  /** 正则快速匹配（无模型调用） */
  private static PATTERNS = [
    /^(记住|记下|别忘了|以后|今后).+/,
    /^我(喜欢|偏好|习惯).+/,
    /(帮我|请|麻烦)(记住|记录|记下).+/,
  ]

  /** 第一步：正则快筛，延迟 < 1ms */
  quickMatch(message: string): boolean {
    return WriteIntentDetector.PATTERNS.some(p => p.test(message.trim()))
  }

  /** 第二步：便宜模型确认 + 提取（仅在 quickMatch 通过后调用） */
  async confirmAndExtract(message: string): Promise<WriteIntentResult | null> {
    // Prompt 定义见 [ContextEngineering - 写入拦截确认 Prompt]
    const response = await this.cheapModel.complete(WRITE_INTENT_PROMPT, message)
    const parsed = JSON.parse(response)

    if (!parsed.write) return null

    const resolved = this.resolvePathAndTarget(parsed.type)
    if (!resolved) return null  // 未知 type → 放弃拦截，交给 Agent 处理

    return { ...resolved, content: parsed.content }
  }

  /** 将模型返回的 type 映射为合法的 path + target 组合。
   *  返回 null 表示无法映射（模型输出偏离 schema），拦截器应放弃处理。 */
  private resolvePathAndTarget(type: string): { path: 'A' | 'B'; target: string } | null {
    switch (type) {
      case 'global_pref': return { path: 'A', target: 'global' }
      case 'agent_pref': return { path: 'A', target: 'agent' }
      case 'task_note':   return { path: 'A', target: 'memo' }
      case 'knowledge':   return { path: 'B', target: 'note' }
      default:            return null  // 未知 type，不构造非法组合
    }
  }
}

interface WriteIntentResult {
  path: 'A' | 'B'
  target: string
  content: string
}
```

### Session 结束写入流

```typescript
// packages/memory/src/lifecycle.ts

class SessionLifecycle {
  private writer: MemoryWriter
  private classifier: EventClassifier

  async onSessionEnd(session: SessionRecord, isInterrupt: boolean): Promise<void> {
    if (isInterrupt) return this.handleInterrupt(session)
    return this.handleNormalEnd(session)
  }

  private async handleNormalEnd(session: SessionRecord): Promise<void> {
    // 1. 生成 Session 分析（便宜模型）
    // Prompt 定义见 [ContextEngineering - Session 分析 Prompt]
    const analysis = await this.analyzeSession(session)

    // 2. Path B: 写入 session 总结
    await this.writer.write({
      path: 'B', target: 'session',
      content: analysis.summary,
      confidence: 0.8, status: 'verified',
      sessionId: session.id, agentName: session.agentName,
      tags: this.extractTags(session),
    })

    // 3. Path B: 提炼知识条目
    for (const item of analysis.extractable) {
      await this.writer.write({
        path: 'B', target: item.type,
        content: item.content,
        confidence: 0.6, status: 'draft',
        sessionId: session.id, agentName: session.agentName,
        tags: item.tags,
      })
    }

    // 4. Path A: 清理 memo 已完成条目
    for (const entry of analysis.memoCleanup) {
      await this.writer.write({
        path: 'A', target: 'memo',
        operation: 'remove',
        content: entry, // 待删除的条目内容（用于匹配定位）
        confidence: 1, status: 'verified',
        sessionId: session.id, agentName: session.agentName,
      })
    }

    // 5. Path A: 更新 preferences（行为纠正）
    for (const update of analysis.preferenceUpdates) {
      await this.writer.write({
        path: 'A', target: update.target,
        content: update.content,
        confidence: 1, status: 'verified',
        sessionId: session.id, agentName: session.agentName,
      })
    }

    // 6. 审查本 Session 的 inbox 条目
    await this.reviewInbox(session.id, analysis)
  }

  private async handleInterrupt(session: SessionRecord): Promise<void> {
    // Path B: 部分总结
    const partial = await this.generatePartialSummary(session)
    if (partial) {
      await this.writer.write({
        path: 'B', target: 'session',
        content: partial,
        confidence: 0.5, status: 'draft',
        sessionId: session.id, agentName: session.agentName,
        tags: ['interrupted'],
      })
    }

    // Path A: memo 标记中断（不清理，追加中断标记）
    await this.writer.write({
      path: 'A', target: 'memo',
      operation: 'update',
      content: `**中断**：Session ${session.id} 因异常中断，任务未完成`,
      confidence: 1, status: 'verified',
      sessionId: session.id, agentName: session.agentName,
    })
  }
}
```

---

## 启动流程

```
用户登录 macOS
  │
  ▼
LaunchAgent 启动 Supervisor
  │
  ▼
Supervisor 启动主进程（apps/server）
  │
  ▼
┌──────────────────────────────────────────┐
│  主进程启动序列                            │
│                                           │
│  1. 从 macOS Keychain 读取主密钥           │
│  2. 解密 .zero/secrets.enc 到内存          │
│  3. 加载 config.yaml                      │
│  4. 初始化 SQLite (metrics.db)            │
│  5. 加载向量索引                           │
│  6. 初始化 Model Registry + Router        │
│  7. 初始化 6 个基础 Tool（含 Fetch）        │
│  8. 启动 Channel 监听（飞书/TG/Web）       │
│  9. 启动 Web UI（Hono 服务）               │
│  10. 同步 Scheduler 到系统 crontab         │
│  11. 开始写心跳                            │
│  12. 发送启动通知                          │
└──────────────────────────────────────────┘
```

---

## 数据流总览

一次完整的用户交互，数据经过的路径：

```
用户发消息（飞书/TG/Web）
  │
  ├──→ Channel 接收，创建/复用 Session
  │
  ├──→ 框架层写入拦截（WriteIntentDetector）
  │      ├──→ 正则快筛用户消息（< 1ms）
  │      └──→ 命中 → 便宜模型确认 + 提取 → MemoryWriter.write()
  │
  ├──→ 记忆检索（独立调用，走便宜模型）
  │      └──→ Embedding API → 向量检索 → 返回记忆片段
  │
  ├──→ 组装上下文 = 身份记忆 + 检索记忆 + 对话历史 + 用户消息
  │      └──→ 结束对应 snapshot trace span，追加到 trace.jsonl（如有变化）
  │
  ├──→ Model Router 选择模型
  │      └──→ Provider Adapter 调用 LLM API（流式）
  │             └──→ 结束对应 llm_request trace span，追加到 trace.jsonl
  │
  ├──→ Agent 处理响应
  │      ├── 文本响应 → 流式推送给 Channel + WebSocket
  │      └── Tool Use → 执行工具
  │             ├──→ 熔断检查
  │             ├──→ 文件锁（如需要）
  │             ├──→ 执行
  │             ├──→ 写入 events.jsonl
  │             ├──→ 结束对应 trace span，追加到 trace.jsonl
  │             ├──→ bus.emit('tool:call', ...)
  │             ├──→ 检查排队消息队列（有则注入后继续循环）
  │             ├──→ MemoryWrite 工具 → MemoryWriter.write()（Agent 指定 path + target）
  │             └──→ 结果返回给 Agent，继续循环
  │
  ├──→ Session 结束（SessionLifecycle）
  │      ├──→ 便宜模型生成 Session 分析
  │      ├──→ Path B: 写入 session 总结（confidence 0.8, verified）
  │      ├──→ Path B: 提炼知识条目（confidence 0.6, draft）
  │      ├──→ Path A: 清理 memo 已完成条目
  │      ├──→ Path A: 更新 preferences（行为纠正）
  │      ├──→ 审查 inbox 条目
  │      └──→ 更新 memory.md 索引
  │
  └──→ 全程密钥过滤（所有输出经 SecretFilter）
```

---

## 部署

ZeRo OS 是纯本机系统，不涉及服务器部署。"部署"即安装到用户的 Mac 上。

### 初始安装

```bash
# 1. 克隆仓库
git clone https://github.com/user/zero-os.git
cd zero-os

# 2. 安装依赖
bun install

# 3. 构建前端（后端免构建）
bun run build:web

# 4. 初始化（交互式）
#    - 生成主密钥存入 Keychain
#    - 创建 .zero/ 目录结构
#    - 配置 Provider 凭证（API Key / OAuth Token）
#    - 注册 LaunchAgent
bun zero init

# 5. 启动
bun zero start
```

### LaunchAgent 配置

```xml
<!-- ~/Library/LaunchAgents/com.zero-os.supervisor.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.zero-os.supervisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/.bun/bin/bun</string>
    <string>run</string>
    <string>/path/to/zero-os/apps/supervisor/src/main.ts</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/path/to/.zero/logs/supervisor.log</string>
  <key>StandardErrorPath</key>
  <string>/path/to/.zero/logs/supervisor.error.log</string>
</dict>
</plist>
```

### 自更新

AI 修改代码后的自动更新流程：

```
AI 修改代码
  │
  ├──→ git add + git commit（自动）
  ├──→ bun run build:web（仅需重建前端，后端免构建）
  ├──→ 验证（启动新进程，健康检查通过）
  ├──→ 通知 Supervisor 重启主进程
  ├──→ 观察期（设定时间内无异常）
  └──→ git tag stable（标记稳定版本）
```

---

## 依赖清单

核心生产依赖（不含 devDependencies）：

```
# AI / LLM
@anthropic-ai/sdk          # Anthropic Messages API
openai                     # OpenAI Chat Completions + Responses + Embedding
tiktoken                   # Token 计数

# 存储（SQLite 由 bun:sqlite 内置提供）
vectra                     # 本地 HNSW 向量索引
yaml                       # YAML 解析
gray-matter                # Markdown Frontmatter

# Web
hono                       # HTTP + WebSocket + RPC
react                      # UI
react-dom
recharts                   # 图表
@codemirror/view           # Markdown 编辑器
@codemirror/lang-markdown
@tanstack/react-router     # 路由
@tanstack/react-query      # 数据获取
zustand                    # 状态管理
@tanstack/react-virtual    # 虚拟列表
react-markdown             # Markdown 渲染
remark-gfm
lucide-react               # 图标

# 网页内容提取（Fetch 工具）
@mozilla/readability       # HTML 正文提取
turndown                   # HTML → Markdown 转换

# 系统交互（子进程 / Shell / ID 生成由 Bun 内置提供）
chokidar                   # 文件监听
simple-git                 # Git 操作
proper-lockfile            # 文件锁
cron-parser                # Cron 解析

# 浏览器自动化（Browser Skill，非核心依赖，按需安装）
# agent-browser            # CDP 连接真实 Chrome，通过 CLI 调用

# Channel
@larksuiteoapi/node-sdk    # 飞书
telegraf                   # Telegram
```

总计约 23 个核心依赖（Bun 内置替换了 `better-sqlite3`、`execa`、`nanoid`）。Playwright 已移除，替换为 `@mozilla/readability` + `turndown`（~100KB vs ~150MB），浏览器自动化改用 `agent-browser`（CDP 连接真实 Chrome）作为 Skill 按需使用。无重型框架（无 LangChain、无 Next.js、无 Prisma），无 native addon，保持可审计和 AI 可理解。
