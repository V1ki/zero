# ZeRo OS

[English README](./README.md)

ZeRo OS 是一个基于 Bun + TypeScript 的 monorepo，用来运行一个具备工具调用、
长期记忆、可观测性、任务调度、渠道适配、Web 控制台，以及可选 supervisor 守护进程
的持久化 agent runtime。

它不是一个单纯的聊天 UI。这个仓库围绕一个可持续运行的系统展开，能够：

- 在多个已配置模型提供方之间完成模型路由
- 持久化会话、日志、指标、追踪和长期记忆
- 通过 HTTP + WebSocket 暴露浏览器控制台
- 将 runtime 接入 Web、Telegram 和飞书渠道
- 通过 cron 风格任务调度执行工作
- 通过 supervisor 监控存活并在必要时执行修复

## 仓库包含什么

- `apps/server`：主 CLI 和 runtime 启动入口
- `apps/web`：Hono + Bun 服务端，以及 React 控制台
- `apps/supervisor`：心跳监控与重启循环
- `packages/*`：可复用的 runtime、模型、记忆、渠道、调度、可观测性和共享模块
- `e2e/*`：面向操作者工作流的 Playwright 端到端测试

## 架构

### Runtime 分层

- `packages/shared` 提供系统契约、配置类型、消息结构和通用工具，是整个 monorepo 的
  基础层。
- `packages/secrets` 负责加密 vault 和输出脱敏。
- `packages/model` 负责 provider、adapter、认证策略和模型选择。
- `packages/memory` 负责 Markdown 记忆存储、memo 状态、向量索引和检索逻辑。
- `packages/observe` 负责日志、指标、trace、会话状态和 schedule 状态的持久化。
- `packages/core` 负责组装 agent loop、工具、会话、bootstrap context 和任务编排。
- `packages/channel` 将 runtime 适配到 WebSocket、Telegram 和飞书消息流。
- `packages/scheduler` 负责 cron 风格任务，并将触发执行交回 runtime。
- `packages/supervisor` 负责存活监控、修复辅助能力和基于 git 的恢复原语。
- `apps/*` 将上述模块组合为可运行的进程入口。

### 进程拓扑

1. `bun zero start` 从 `apps/server/src/cli.ts` 中的 CLI 入口进入。
2. CLI 在 `apps/server/src/main.ts` 中初始化 ZeRo OS runtime。
3. Runtime 加载配置、密钥、工具、模型路由、记忆、可观测性、会话、渠道和调度器。
4. `apps/web/src/server.ts` 中的 Web 服务挂载 HTTP API、提供已构建的 SPA，并暴露
   WebSocket 实时桥接。
5. 可选的 `apps/supervisor/src/main.ts` 会监控 `.zero/heartbeat.json`，在心跳过期时
   重新构建并重启主进程。

### 请求流

1. 输入消息从 Web、Telegram 或飞书进入系统。
2. 渠道层将其标准化为共享的 runtime 消息类型。
3. `SessionManager` 查找或创建绑定的会话。
4. Agent 从配置、bootstrap 文件、会话历史和记忆中构建 prompt context。
5. `ModelRouter` 选择当前配置的模型和 provider。
6. 工具循环可以读写文件、执行带 fuse 约束的 shell、抓取 URL、检索记忆和创建调度任务。
7. 日志、trace、指标和会话状态通过可观测层落盘。
8. 最终响应通过原始渠道返回。

## 运行时状态

ZeRo OS 会把本地运行数据放在 `.zero/` 下。这个目录是运行态数据，不是产品源码。

- `.zero/config.yaml`：providers、models、channels、schedules 和可选 embedding 配置
- `.zero/secrets.enc`：加密的 secret vault
- `.zero/fuse_list.yaml`：shell 执行安全规则
- `.zero/memory/**`：长期记忆文件
- `.zero/workspace/**`：bootstrap 文件和 agent 工作区状态
- `.zero/logs/**`：日志、指标和持久化会话数据
- `.zero/heartbeat.json`：供 supervisor / restart 流程使用的存活信号

不要提交 `.zero/`、`dist/`、`node_modules/` 或 `test-results/`。

## 环境要求

- Bun
- 当前默认 secret 管理流程需要 macOS

secret 层直接使用 macOS 的 `security` CLI，并把主密钥保存进 Keychain。`launchctl`
集成同样是 macOS 专属。仓库里很多代码本身是可移植的，但这个项目当前默认的运行路径
是围绕 macOS 设计的。

## 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 初始化本地运行状态

```bash
bun zero init
```

这一步会创建本地 runtime 目录，生成或加载主密钥，初始化加密 vault，并把默认
bootstrap 文件写入 `.zero/workspace/zero/`。

如果希望初始化时一并写入主要 API key：

```bash
bun zero init <your-api-key>
```

之后也可以单独写入：

```bash
bun zero secret set openai_codex_api_key <your-api-key>
```

### 3. 创建 `.zero/config.yaml`

`bun zero init` 不会创建 runtime 配置文件。只要 `.zero/config.yaml` 不存在，
`bun zero start` 就会直接失败。

最小示例：

```yaml
providers:
  openai:
    api_type: openai_chat_completions
    base_url: https://api.openai.com/v1
    auth:
      type: api_key
      api_key_ref: openai_codex_api_key
    models:
      gpt5:
        model_id: gpt-5.4
        max_context: 400000
        max_output: 128000
        capabilities:
          - tools
          - reasoning
        tags:
          - primary
default_model: openai/gpt5
fallback_chain:
  - openai/gpt5
channels:
  - name: web
    type: web
    enabled: true
    receive_notifications: true
```

可选项：

- `.zero/fuse_list.yaml`：用于 shell 安全规则
- `.zero/config.yaml` 中的 embedding 配置：用于向量记忆检索
- 额外的 Telegram / 飞书 channel 定义

### 4. 构建 Web UI

```bash
bun run build:web
```

Runtime 会从 `apps/web/dist` 提供 SPA。若 UI 尚未构建，服务端会直接返回提示，要求先
执行构建步骤。

### 5. 启动 ZeRo OS

```bash
bun zero start
```

默认情况下，UI 和 API 会监听在 `http://localhost:3001`。

常用端点：

- `GET /api/status`：健康检查 / 状态探针
- `GET /api/sessions`：会话列表
- `GET /api/models`：可用模型列表
- `WS /ws`：控制台使用的实时事件桥

## Web 控制台

操作台是由 Bun 服务托管的 React 应用，覆盖：

- dashboard 和 runtime 健康状态
- sessions 及深度会话检查
- memory 和 memo 管理
- tool registry 可见性
- logs 和 metrics
- config 与 provider 状态
- 基于 WebSocket 的实时更新

前端技术栈包括 Vite、React 19、TanStack Router、TanStack Query、Zustand、Hono
和 Recharts。

## CLI

主要入口：

```bash
bun zero <command>
```

常用命令：

```bash
bun zero start
bun zero restart
bun zero status
bun zero logs all --follow
bun zero secret set <key> <value>
bun zero secret list
bun zero secret delete <key>
bun zero launchctl install
bun zero launchctl status
bun zero launchctl uninstall
```

Agent 可见的 Zero 命令手册统一放在 `docs/zero-cli.md`。涉及 `bun zero ...`
操作时，以这份文档作为受控暴露面。

ChatGPT OAuth 会在请求前按需自动续期，并在首次 401 后尝试刷新一次再重试。只有当 refresh token 已失效或被撤销时，才需要重新执行 `bun zero provider login chatgpt`。

Claude browser OAuth 也已经接入到同一套 managed callback 流程中。ZeRo OS 会把 Claude 凭证以 session JSON 的形式保存到 vault，运行时再解析出 access token，并在 refresh grant 仍有效时自动续期。只有当 Claude 明确要求重新认证时，才需要重新执行 `bun zero provider login anthropic`。

## 开发工作流

### 日常命令

```bash
bun run dev:web
bun run build:web
bun run check
bun run lint
bun run lint:fix
bun run test
bun run test:e2e
```

### 验证基线

- `bun run check`：TypeScript 基线检查
- `bun run lint`：Biome lint / format 校验
- `bun run test`：递归执行 `packages/*` 和 `apps/*` 下的 Bun 测试
- `bun run test:e2e`：针对 `http://localhost:3001` 的 Playwright E2E

Playwright 配置会自动启动 `bun zero start`，并等待
`http://localhost:3001/api/status`。当前 E2E 默认只跑 Chromium。

## 测试覆盖形态

仓库已经具备较完整的自动化覆盖，既覆盖 runtime，也覆盖操作台体验。

- 单元 / 集成测试覆盖 agent 行为、工具恢复、预算控制、配置解析、模型路由、会话生命
  周期、记忆检索、可观测性、调度行为和渠道适配
- Playwright E2E 覆盖导航、dashboard 组件、sessions、session detail、memory、
  memo 编辑、tools、logs、metrics、config CRUD、notifications、响应式布局、
  skeleton 状态、error boundary、流式聊天和 WebSocket 驱动的 UI 行为

这意味着仓库已经把 Web 控制台和 runtime API 视为正式的回归面，而不是一个演示壳。

## 仓库结构

```text
apps/
  server/       CLI、runtime bootstrap、channel wiring、启动路径
  web/          API 路由、WebSocket bridge、React operator UI
  supervisor/   heartbeat monitor 与 repair loop
packages/
  shared/       共享类型与工具
  secrets/      加密 vault 与 secret filtering
  model/        provider adapters、auth、model routing
  memory/       长期记忆存储与检索
  observe/      logs、metrics、trace、session persistence
  core/         agent runtime、tool loop、sessions、bootstrap loading
  channel/      Web、Telegram、飞书 adapters
  scheduler/    cron 风格任务调度
  supervisor/   repair engine、heartbeat utilities、git ops
e2e/            Playwright 端到端覆盖
.zero/          本地 runtime state、memory、logs、secrets、workspace
```

## 安全与运维说明

- secrets 在写入日志或模型 / 工具输出前会经过过滤
- shell 执行受 fuse-list 规则约束
- 长期记忆作为本地文件保存在 `.zero/memory` 下
- schedule 和 session 状态通过可观测层持久化
- supervisor 对本地开发不是必需的，但它是项目设计中的自愈重启路径

## 工作区摘要

高层看，`apps/*` 放可运行入口，`packages/*` 放 runtime 能力，`e2e/*` 定义系统
面向用户的回归基线。
