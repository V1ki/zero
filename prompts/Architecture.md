# ZeRo OS

ZeRo OS 是一个可在本机自动执行任务的 AI 系统。

目标是把电脑作为实验场，让 AI 能执行命令、构建工具、自动修复并重启更新。

> **文档关系说明**：本文档定义系统架构和模块职责。技术选型、命名规范、包依赖关系等实现细节以 [TechStack] 文档为准。本文档中出现数据结构示例时，使用持久化层格式（snake_case），TypeScript 代码层格式详见 [TechStack - 命名规范]。

## 核心思想

1. AI 可以修改代码并修复 Bug。
2. AI 可以构建和扩展工具。
3. AI 可以在可控条件下完成自我更新与重启。

---

## 全局架构

```
┌─────────────────────────────────────────────────────────┐
│                       触发源                             │
│   ┌────────┐  ┌──────────┐  ┌──────────┐               │
│   │  飞书   │  │ Telegram │  │ Scheduler│    ...        │
│   └───┬────┘  └────┬─────┘  └────┬─────┘               │
└───────┼────────────┼─────────────┼──────────────────────┘
        │            │             │
        ▼            ▼             ▼
┌─────────────────────────────────────────────────────────┐
│                      Session                             │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │  身份记忆（全局 + Agent + 备忘录）+ 工作记忆检索    │ │
│  └────────────────────────────────────────────────────┘ │
│                         │                                │
│  ┌──────────────────────▼─────────────────────────────┐ │
│  │                  Agent                              │ │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────────┐│ │
│  │  │ Read │ │Write │ │ Edit │ │ Bash │ │ Fetch    ││ │
│  │  └──────┘ └──────┘ └──────┘ └──────┘ └──────────┘│ │
│  │  ┌──────────────────────────────────────────────┐ │ │
│  │  │ Task（SubAgent 编排）                         │ │ │
│  │  └──────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────┘ │
│                         │                                │
│  ┌──────────────────────▼─────────────────────────────┐ │
│  │              Model Router                           │ │
│  │              Provider Adapter                       │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
        │              │              │
        ▼              ▼              ▼
┌─────────────┐ ┌────────────┐ ┌───────────┐
│  Anthropic  │ │   OpenAI   │ │  其他服务  │
└─────────────┘ └────────────┘ └───────────┘

横切关注点（所有层共享）：
  ├─ 保密箱（.zero/secrets.enc）
  ├─ 观测性（.zero/logs/）
  ├─ 记忆（.zero/memory/）
  ├─ 版本管理（Git）
  └─ 并发安全（Tool 级文件锁）
```

---

## 工作区结构

ZeRo OS 的所有数据统一存放在 `.zero/` 目录下：

```
.zero/
  ├─ config.yaml         # 系统配置（模型注册表、Scheduler、降级链等）
  ├─ fuse_list.yaml      # 熔断名单，AI 执行命令前检查，命中则拒绝并告警
  ├─ secrets.enc         # 加密密钥文件，主密钥存于 macOS Keychain
  ├─ heartbeat.json      # 进程心跳文件，Supervisor 据此判断主进程是否存活
  ├─ restart-sentinel.json # 重启恢复哨兵，仅记录关闭时仍被中断的 Session（临时文件）
  ├─ channels/           # AI 自建或用户后续接入的 Channel 扩展（运行时目录）
  │                      # 内置 Channel（飞书、Telegram、Web）在源码 packages/channel 中
  ├─ tools/              # AI 构建的自定义工具
  ├─ skills/             # AI 的技能定义，封装复杂业务流程
  │   └─ browser/        #   浏览器自动化 Skill（SKILL.md + evals/）
  ├─ logs/               # 事件日志与 Session 记录
  │   ├─ events.jsonl        #   全局系统事件流（追加写入）
  │   ├─ requests.jsonl      #   全局 LLM 请求记录（legacy fallback）
  │   ├─ notifications.jsonl #   通知记录（追加写入）
  │   ├─ metrics.db          #   SQLite，聚合查询用
  │   ├─ sessions.db         #   SQLite，Session 持久化
  │   ├─ supervisor.log      #   Supervisor 标准输出
  │   ├─ supervisor.error.log#   Supervisor 错误输出
  │   └─ sessions/           #   按 Session 分区的日志
  │       └─ {sessionId}/
  │           ├─ trace.jsonl     # 该 Session 的执行 Trace（span 记录）
  │           ├─ requests.jsonl  # 该 Session 的 LLM 请求台账
  │           ├─ snapshots.jsonl # 该 Session 的上下文快照台账
  │           └─ closure.jsonl   # 该 Session 的任务关闭台账
  ├─ memory/             # 记忆库
  │   ├─ memo.md         #   备忘录（AI 与人类共同编辑）
  │   ├─ memory.md       #   全局索引页
  │   ├─ vectors/        #   向量嵌入索引（语义检索用）
  │   ├─ preferences/    #   身份记忆
  │   │   ├─ global.md   #     全局偏好
  │   │   └─ agents/     #     各 Agent 身份记忆
  │   ├─ sessions/       #   任务会话记录
  │   ├─ incidents/      #   故障案例
  │   ├─ runbooks/       #   可重复执行流程
  │   ├─ decisions/      #   架构和策略决策
  │   ├─ notes/          #   用户主动保存内容
  │   ├─ inbox/          #   待整理原始记录
  │   └─ archive/        #   归档数据
  └─ workspace/          # AI 的工作目录
      ├─ {agent}/        #   每个 Agent 独立的工作目录
      │   ├─ SOUL.md     #     Agent 人格定义
      │   ├─ USER.md     #     用户画像
      │   └─ TOOLS.md    #     工具环境说明
      └─ shared/         #   共享目录，最终产出物放这里，供用户和其他 Agent 访问
```

每个 Agent 只在自己的目录下工作，临时文件和草稿不影响其他 Agent。需要交付的产出物放到 `shared/`，`shared/` 遵循 Write/Edit 的文件锁。

---

## 安全策略

系统默认放行所有操作，给予 AI 最大控制能力。仅通过熔断名单和操作日志做最低限度的保护。

### 熔断名单

极少数不可逆且大概率是误操作的命令会被拦截（如 `rm -rf /`、`mkfs`、`dd if=/dev/zero`）。名单维护在 `.zero/fuse_list.yaml`，用户可自行修改。

### 操作日志

所有操作记录完整的结构化日志，详见「观测性」章节。

---

## 工具

系统提供 6 个基础能力：

1. `Read`：读取文件内容，支持按范围读取。
2. `Write`：在工作区写入新内容。
3. `Edit`：对现有文件做精确修改。
4. `Bash`：执行系统命令（Mac）。
5. `Fetch`：HTTP 请求，读取网页内容 / API / 下载文件。底层使用 Bun 内置 `fetch()` + `@mozilla/readability` + `turndown`（HTML → Markdown），依赖极轻（~100KB），无锁完全并发。
6. `Task`：启动 SubAgent 执行特定任务，包含预设 SubAgent（Explorer 等），也支持用户自定义。

### Fetch 工具

Fetch 覆盖 90% 的网页访问场景（读文档、调 API、下载文件），返回可读文本。

- **输入**：`{ url, method?, headers?, body?, format?, timeout?, credentialRef? }`
- **输出**：`{ status, body(markdown/json/text), truncated }`
- `format: 'auto'` 根据 Content-Type 自动选择：HTML → readability 提取正文 → markdown；JSON → 格式化输出；其他 → 原文
- `credentialRef` 支持从保密箱注入认证信息（Bearer token、API Key 等）
- HTML 处理流程：先用 readability 提取正文（去掉导航/广告/侧栏），不够时退回 turndown 全页转换

如果页面需要 JavaScript 渲染或交互操作，通过 Bash 调用 `agent-browser`（见「Browser Skill」）。

### Bash 安全约束

Bash 命令默认全放行，仅受熔断名单约束。所有执行记录写入操作日志。

### Browser Skill

浏览器交互能力不再作为核心工具，而是作为 Skill 通过 `agent-browser` + CDP 提供。

**为什么降级为 Skill**：

1. 90% 场景（读文档、调 API）不需要 Playwright + Chromium（~150MB），Fetch 即可覆盖。
2. 无头浏览器容易被反爬检测（Cloudflare、reCAPTCHA 等），CDP 连接真实 Chrome 则不会。
3. 核心工具应有明确的 input/output Schema，浏览器交互的 Schema 难以统一定义。

**集成方式**：

```
┌─────────────────────────────────────────┐
│              Agent                       │
│                                          │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐  │
│  │ Read │ │Write │ │ Edit │ │ Bash │──┐│
│  └──────┘ └──────┘ └──────┘ └──────┘  ││
│  ┌──────┐ ┌──────────────────────────┐ ││
│  │Fetch │ │ Task（SubAgent 编排）     │ ││
│  └──────┘ └──────────────────────────┘ ││
│                                         ││
│  Skill: Browser（.zero/skills/browser/）││
│  ┌──────────────────────────────────┐  ││
│  │ SKILL.md — 描述浏览器工作流      │◄─┘│
│  │ 底层：agent-browser CLI via Bash │   │
│  │ 连接：CDP → 用户的 Chrome        │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

- AI 通过 Bash 调用 `agent-browser` CLI 命令操作浏览器，不需要额外的 Tool 定义
- agent-browser 通过 CDP 连接到用户的 Chrome（或按需启动 headed Chrome），复用已登录的 session
- Session 隔离由 agent-browser 的 `--session` 机制处理
- Skill 通过 `.zero/skills/browser/SKILL.md` 定义工作流，教 AI 怎么用 agent-browser

**agent-browser 核心工作流**（Snapshot/Ref 模型）：

```
1. agent-browser open <url>          → 打开页面
2. agent-browser snapshot -i         → 获取交互元素的可访问性树（@e1, @e2...）
3. agent-browser click @e3           → 用 ref 点击元素
4. agent-browser fill @e5 "text"     → 用 ref 填写表单
5. agent-browser snapshot -i         → DOM 变化后重新获取快照
6. agent-browser close               → 完成后关闭
```

| 维度 | Playwright 无头 | CDP 连接真实 Chrome |
|------|----------------|-------------------|
| 反爬检测 | 容易被检测阻止 | 和用户正常浏览一样 |
| 登录状态 | 需要重新登录 | 复用用户已登录的 session |
| 用户可见性 | 后台运行，不可见 | 用户能看到 AI 在做什么 |
| 资源占用 | 额外启动 Chromium 进程 | 复用已有的 Chrome |

---

## 工具构建

### 1) 使用网络已有 MCP/SKILL

1. 下载源码。
2. 做安全审查（可疑命令、异常外联、权限越界）。
3. 有风险先修复或隔离，再接入系统。
4. 审查通过后进入可信工具列表。

### 2) 自建 Tool/SKILL

1. **Tool**：封装外部 API（例如图片生成 API）。
2. **SKILL**：封装复杂业务流程（例如公众号上传、草稿审阅、发布）。

### 工具选择原则

1. 优先稳定和可审计。
2. 无法确认安全时，默认不自动启用。

---

## 模型层

系统支持多模型接入和运行时切换，采用两层架构：

```
┌─────────────────────────────────┐
│           Session               │
│  ┌───────────────────────────┐  │
│  │     Model Router          │  │
│  │  - 当前活跃模型            │  │
│  │  - 模型切换（精确/模糊/NL）│  │
│  │  - 降级链                  │  │
│  └──────────┬────────────────┘  │
│             │                   │
│  ┌──────────▼────────────────┐  │
│  │   Provider Adapters       │  │
│  │  - Anthropic Messages API │  │
│  │  - OpenAI Chat Completions│  │
│  │  - OpenAI Responses API   │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

### Model Registry（模型注册表）

以 Provider 为顶层组织，每个 Provider 配置一次连接信息、认证方式和凭证，其下挂载多个模型：

```yaml
providers:
  anthropic:
    api_type: anthropic_messages
    base_url: https://api.anthropic.com
    auth_type: api_key                     # api_key | oauth_token | oauth_chatgpt
    credential_ref: anthropic_api_key      # 保密箱中的凭证引用名
    models:
      claude-opus:
        model_id: claude-opus-4-6
        max_context: 200000
        max_output: 32000
        capabilities: [tools, vision, reasoning]
        tags: [powerful]

      claude-sonnet:
        model_id: claude-sonnet-4-5-20250929
        max_context: 200000
        max_output: 8192
        capabilities: [tools, vision]
        tags: [fast, balanced]

  # Anthropic OAuth Token 示例（粘贴输入，sk-ant-oat- 前缀，需 Beta Headers + SDK authToken 参数）
  anthropic-oauth:
    api_type: anthropic_messages
    base_url: https://api.anthropic.com
    auth_type: oauth_token
    credential_ref: anthropic_oauth_token
    models:
      claude-opus-oauth:
        model_id: claude-opus-4-6
        max_context: 200000
        max_output: 32000
        capabilities: [tools, vision, reasoning]
        tags: [powerful]

  openai:
    api_type: openai_chat_completions
    base_url: https://api.openai.com
    auth_type: api_key
    credential_ref: openai_api_key
    models:
      gpt-4o:
        model_id: gpt-4o
        max_context: 128000
        max_output: 16384
        capabilities: [tools, vision]
        tags: [fast, balanced]

  # ChatGPT OAuth 示例（通过浏览器登录获取 Token）
  chatgpt:
    api_type: openai_chat_completions
    base_url: https://api.openai.com
    auth_type: oauth_chatgpt
    credential_ref: chatgpt_oauth_token
    models:
      gpt-4o-oauth:
        model_id: gpt-4o
        max_context: 128000
        max_output: 16384
        capabilities: [tools, vision]
        tags: [fast, balanced]

  openai-responses:
    api_type: openai_responses
    base_url: https://api.openai.com
    auth_type: api_key
    credential_ref: openai_api_key
    models:
      o3:
        model_id: o3
        max_context: 200000
        max_output: 100000
        capabilities: [tools, vision, reasoning]
        tags: [reasoning]

  deepseek:
    api_type: openai_chat_completions
    base_url: https://api.deepseek.com
    auth_type: api_key
    credential_ref: deepseek_api_key
    models:
      deepseek-r1:
        model_id: deepseek-reasoner
        max_context: 65536
        capabilities: [tools, reasoning]
        tags: [cheap]
```

新增模型只需在对应 Provider 下添加条目，无需重复配置连接信息和凭证。新增 Provider 只需定义一次 `api_type`、`base_url`、`auth_type` 和 `credential_ref`。

### 认证方式

系统支持三种认证方式，由 Provider 级别的 `auth_type` 字段决定：

| auth_type | 凭证获取方式 | 请求注入方式 | 适用场景 |
|-----------|-------------|-------------|---------|
| `api_key` | 用户粘贴输入 | Anthropic: `x-api-key` 请求头；OpenAI 兼容: `Authorization: Bearer <key>` | 所有支持 API Key 的服务 |
| `oauth_token` | 用户粘贴输入 | Anthropic SDK `authToken` 参数 + Beta Headers | Anthropic OAuth Token（`sk-ant-oat-` 前缀），通过 SDK 的 `authToken` 参数注入，需附加 `anthropic-beta` 协议头。详见 [TechStack - Anthropic OAuth Token] |
| `oauth_chatgpt` | 浏览器 OAuth 登录流程，通过回调获取 | `Authorization: Bearer <token>` | ChatGPT 官方 OAuth |

所有凭证统一存入保密箱，`credential_ref` 是保密箱中的键名。凭证过期（OAuth Token）时，系统通过 Provider Adapter 的健康检查发现，并提示用户重新授权。

### 模型定价与用量追踪

模型价格默认从 [litellm/model_prices_and_context_window.json](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) 获取，单位为 $/M tokens（每百万 Token 的美元价格）。如需覆盖，可在模型配置中显式指定：

```yaml
# 覆盖示例：在模型配置中添加 pricing 字段
claude-opus:
  model_id: claude-opus-4-6
  max_context: 200000
  max_output: 32000
  capabilities: [tools, vision, reasoning]
  tags: [powerful]
  pricing:                        # 可选，不填则使用 litellm 默认值
    input: 15.0                   # $/M input tokens
    output: 75.0                  # $/M output tokens
    cache_write: 18.75            # $/M 写入缓存 tokens
    cache_read: 1.5               # $/M 命中缓存 tokens
    reasoning: 0                  # $/M reasoning tokens（仅 reasoning 模型需要）
```

系统按每次 LLM 请求记录完整调用信息，使用 JSONL 追加写入，SQLite 做聚合查询。

**请求记录**（当前优先写入 `trace.jsonl` 的 `llm_request` span；`requests.jsonl` 保留为 legacy fallback，字段使用 snake_case，详见 [TechStack - 命名规范]）：

```jsonl
{
  "id": "req_003",
  "parent_id": "req_002",
  "session_id": "sess_001",
  "snapshot_id": "snap_001",
  "model": "claude-sonnet",
  "provider": "anthropic",
  "user_prompt": "帮我改一下 config",
  "response": "好的，已修改...",
  "tokens": {
    "input": 3200,
    "output": 1800,
    "cache_write": 0,
    "cache_read": 800,
    "reasoning": 0
  },
  "cost": 0.028,
  "ts": "2026-02-27T10:05:00Z"
}
```

**上下文快照**（当前优先写入 `trace.jsonl` 的 `snapshot` span；`snapshots.jsonl` 保留为 legacy fallback）：

System Prompt、tools 等上下文信息不随每次请求重复记录，只在发生变化时产生一次快照，请求通过 `snapshot_id` 引用。

```jsonl
{
  "id": "snap_001",
  "session_id": "sess_001",
  "trigger": "session_start",
  "system_prompt": "你是 ZeRo OS 的 Coder Agent...",
  "tools": ["Read", "Write", "Edit", "Bash"],
  "identity_memory": "...",
  "ts": "2026-02-27T10:00:00Z"
}
```

产生新快照的时机：

- **Session 启动**：初始快照，记录完整上下文。
- **模型切换**：不同模型可能 System Prompt 格式不同。
- **工具变化**：新增或移除了 Tool。
- **上下文压缩**：对话历史接近上下文窗口上限时，用便宜模型做摘要压缩，压缩后产生新快照。

```jsonl
{
  "id": "snap_002",
  "session_id": "sess_001",
  "trigger": "context_compression",
  "parent_snapshot": "snap_001",
  "system_prompt": "...",
  "tools": ["Read", "Write", "Edit", "Bash"],
  "compressed_summary": "用户在讨论 ZeRo OS 架构设计，已完成安全策略和模型层...",
  "messages_before": 42,
  "messages_after": 8,
  "compressed_range": "0..33",
  "decision_context": {
    "current_tokens": 18000,
    "conversation_budget": 16000
  },
  "ts": "2026-02-27T11:30:00Z"
}
```

要复现任何一次请求的完整上下文：请求记录 + 对应快照 + `parent_id` 链条上的历史 prompt/response。

**决策视图**（从 `trace.jsonl` 投影，不新增 `decisions.jsonl`）：

Decision 不是新的存储文件，而是 Session 级的结构化投影视图。当前实现从已有 span 数据提取四类决策：

- `context_compression`：来自 `snapshot` span（`trigger='context_compression'`），包含压缩前后消息数、压缩范围，以及 `decision_context`（`current_tokens` / `conversation_budget`）。
- `memory_retrieval`：来自带 `purpose='memory_retrieval_decision'` 的 `llm_request` span，包含 `need`、查询词和检索结果计数。
- `tool_selection`：来自 `stop_reason='tool_use'` 的 `llm_request` span，包含已选工具、工具数量和截断后的 `reasoning_content`。
- `task_closure`：来自 `closure_decision` span，包含 `action` 和 `reason`。

Session 级读取会在请求、快照、closure 之外额外暴露 decision 投影，用于 UI 和 API 的“why”视角，而不改变 trace 原始存储结构。

Token 用量和费用汇总到观测性 Metrics 中，支持按模型、Provider、Session、时间维度统计。

### Provider Adapter（协议适配层）

负责统一不同厂商的 API 调用格式，对上层暴露统一接口：

1. 将内部统一格式转换为各厂商 API 格式（消息结构、Tool Schema、流式输出）。
2. 根据 `auth_type` 选择正确的认证方式：`api_key` 使用 SDK 的 `apiKey` 参数（Anthropic: `x-api-key` 头 / OpenAI: `Authorization: Bearer` 头）；`oauth_token` 使用 Anthropic SDK 的 `authToken` 参数并附加 Beta Headers。
3. 处理重试、错误码映射。Token 过期（401/403）时标记凭证失效并通知用户。
4. 新增 Provider 只需实现统一接口，不影响上层代码。

所有 Provider 均需配置 `base_url`。系统支持三种协议类型：

| 类型 | 默认 BaseUrl | 适用范围 |
|------|-------------|---------|
| Anthropic Messages API | `https://api.anthropic.com` | Claude 系列 |
| OpenAI Chat Completions | `https://api.openai.com` | GPT 系列、DeepSeek、Mistral、vLLM、Ollama 及所有 OpenAI 兼容服务 |
| OpenAI Responses API | `https://api.openai.com` | OpenAI Responses API |

非官方服务只需将 `base_url` 指向对应地址即可，无需额外适配。

### Model Router（模型路由层）

决定每条消息应由哪个模型处理。

**1. 模型切换**

支持三种方式触发切换，按优先级匹配：

| 方式 | 示例 | 说明 |
|------|------|------|
| 精确匹配 | `/model anthropic/Opus 4.6` | 完整的 Registry 名称，直接命中 |
| 模糊命令 | `/model opus` | 对 Registry 中的模型名称做模糊匹配 |
| 自然语言 | `帮我把模型更换为 opus` | 由当前模型识别意图，提取目标模型并匹配 |

匹配规则：

1. 精确匹配优先：输入与 Registry 中的名称完全一致，直接切换。
2. 模糊匹配次之：输入关键词与模型名称、model_id、tags 做模糊匹配，命中唯一结果则切换。
3. 多个匹配时列出候选，让用户选择。
4. 无匹配时提示可用模型列表。

**2. 降级链**

首选模型不可用时，自动沿降级链切换：

```
claude-opus → claude-sonnet → gpt-4o
```

降级时通知用户当前使用的模型已发生变化。

---

## 任务编排

任务编排是 SubAgent 之间的依赖和执行顺序管理。主 Agent 通过 Task 工具启动多个 SubAgent，并定义它们之间的依赖关系。

```
┌──────────────────────────────────────────────────┐
│              Task（主 Agent 发起）                 │
│                                                  │
│  ┌──────────────┐   ┌──────────────┐             │
│  │ SubAgent A   │   │ SubAgent B   │             │
│  │ 调研技术方案1 │   │ 调研技术方案2 │             │
│  └──────┬───────┘   └──────┬───────┘             │
│         │                  │                     │
│         │    A、B 无依赖    │                     │
│         │    并发执行       │                     │
│         ▼                  ▼                     │
│        ┌────────────────────┐                    │
│        │   等待 A + B 完成   │                    │
│        └─────────┬──────────┘                    │
│                  ▼                               │
│         ┌──────────────┐                         │
│         │ SubAgent C   │                         │
│         │ 整合两份报告  │                         │
│         │ 生成最终文档  │                         │
│         └──────────────┘                         │
│                                                  │
│  编排规则：                                       │
│  - 无依赖的 SubAgent 并发执行                     │
│  - 有依赖的 SubAgent 等上游全部完成后再启动        │
│  - 任一 SubAgent 失败，下游取消并通知用户          │
│  - 每个 SubAgent 有独立的超时时间                  │
└──────────────────────────────────────────────────┘
```

---

## 并发安全

多个 Session 同时运行时（多个 IM 窗口、Scheduler 触发等），由 Tool 层自行管理资源冲突：

- **Read**：无锁，任意并发。
- **Write / Edit**：按文件路径加锁，同一文件写互斥。
- **Bash**：默认无锁并发。
- **Fetch**：无锁，完全并发。
- **Browser Skill**（via agent-browser）：agent-browser 自身的 `--session` 机制处理隔离，不需要 ZeRo-OS 层面加锁。

---

## 消息排队

> Agent 在执行任务时收到新消息怎么办？排队，等工具执行完毕后注入。

### 问题场景

Agent 进入 tool use loop（LLM 调用 → 工具执行 → LLM 调用 → ...），一次循环可能持续数分钟。期间用户可能发来新消息：状态查询（"现在处理得怎么样了"）、补充约束（"对了，别改那个文件"）、中断请求（"算了先停下来"）。

### 设计原则

**不打断正在执行的工具**。如果一个 Bash 命令正在跑，不会 kill 它。中断粒度是"回合间隙"——两次 LLM 调用之间的空档，而不是工具执行过程中。这样实现简单，也避免留下半完成的副作用。

### 处理流程

```
用户: "重构 Provider Adapter"
  │
  ▼
Agent 进入 tool use loop:
  LLM 调用 → 返回 tool_use(bash: git diff) → 执行 bash
                                                  │
  ┌─ 此时用户发来新消息 ─────────────────────────┐ │
  │ "现在处理得怎么样了"                          │ │
  │  → 写入 Session 消息队列                      │ │
  │  → 通知 Channel "消息已收到，排队中"           │ │
  └───────────────────────────────────────────────┘ │
                                                  │
  bash 执行完毕 ← ─────────────────────────────────┘
  │
  ▼
  准备下一次 LLM 调用前 ← 检查消息队列
  │
  发现有排队消息，注入对话历史
  │
  ▼
  LLM 看到的上下文:
    [...之前的对话...]
    [tool_result: bash git diff 的输出]
    [user: <queued_message> 包裹的排队消息]
  │
  ▼
  LLM 自然回应 + 继续 tool use loop
```

### 注入与兜底

排队消息用结构化标记包裹注入，让 LLM 明确知道这是"插队消息"而不是新对话（具体格式见 [ContextEngineering - 排队消息注入]）。

**兜底续接**：LLM 回应排队消息后可能返回 `end_turn`（stop_reason）而不是继续 `tool_use`，导致任务静默中断。Agent 层在收到 `end_turn` 时检查当前任务的完成状态——如果任务没有明确完成标志，自动追加一条系统消息触发 LLM 继续执行。最多续接 2 次，避免无限循环。

### 多条排队消息

多条排队消息合并为一次注入——逐条注入会导致每条消息都触发一次 LLM 回应，打断任务节奏。合并策略：

1. Agent 检查队列时，一次性取出所有排队消息。
2. 按时间顺序排列，合并在一个 `<queued_messages>` 标签内。
3. 合并后的消息作为一整条 user 消息注入，LLM 统一回应后继续任务。

### 不适用的场景

排队机制只在 Session 内的 Agent 循环期间生效。以下场景不涉及排队：

- **Agent 空闲时**：用户消息直接触发新一轮 `handleUserMessage`，走正常流程。
- **Scheduler 任务**：无交互对象，不接受排队消息。
- **SubAgent**：不接受外部消息，由主 Agent 管理。

---

## Scheduler

> 定时器，本质上是另一个触发源，跟 IM 消息没有区别。

Scheduler 只做一件事：**到时间了，带着预定义的指令创建一个 Session**。后续执行流程与用户发消息完全一样。

```
┌──────────────────────────────────────┐
│              触发源                   │
│                                      │
│  ┌────────┐  ┌──────────┐           │
│  │  飞书   │  │ Telegram │    ...    │
│  └───┬────┘  └────┬─────┘           │
│      │            │                  │
│  ┌───┴────────────┴──────────┐      │
│  │     Scheduler (Cron)      │      │
│  │  - 每天 2:00 检查更新      │      │
│  │  - 每周一 9:00 生成周报    │      │
│  └─────────────┬─────────────┘      │
└────────────────┼─────────────────────┘
                 │
                 ▼
          创建 Session
          （与 IM 触发完全一样）
                 │
                 ▼
          Agent 执行任务
```

### 配置

```yaml
schedules:
  - name: daily_update_check
    cron: "0 2 * * *"
    instruction: "检查系统更新，有更新则执行升级"
    model: claude-sonnet

  - name: weekly_report
    cron: "0 9 * * 1"
    instruction: "整理上周的 sessions 和 incidents，生成周报"

  - name: memory_cleanup
    cron: "0 3 * * 0"
    instruction: "清理 inbox，归档过期记忆，更新 memory.md 索引，修复 corrupted 状态的记忆条目，补建失败的 related 双向链接"
```

### 实现

使用系统 Cron，每条定时任务对应一个 crontab entry。Cron 由系统管理，即使主进程在重启也不受影响。

### 任务重叠

同一个定时任务上一次还未完成，下一次触发时间又到了时的策略：

- `skip`（默认）：跳过本次。
- `queue`：排队等上一次结束。
- `replace`：终止上一次，启动新的。

### 错过执行

系统宕机期间错过的定时任务，默认不补执行。可通过 `misfire_policy: run_once` 配置恢复后补跑一次。

---

## 备忘录

备忘录是 AI 和人类之间的**异步协作协议**。AI 可以编辑，人类也可以编辑。人类通过编辑影响 AI 的任务方向，AI 通过编辑让人类知道当前状态和计划。

与记忆的区别：记忆是过去发生了什么，备忘录是**现在要做什么、接下来打算怎么做**。备忘录应始终保持精简，过时内容及时清理。

### 存储

`.zero/memory/memo.md`，作为身份记忆的一部分，每次 Agent 启动时加载。

### 结构

一个文件，上半部分是全局区域，下半部分按 Agent 分区：

```markdown
# 备忘录

## 目标
- 本周完成 v2.0 发布
- Channel 模块重构，计划下周开始

## 需要用户处理
- Telegram Bot Token 还未提供
- v2.0 changelog 需要人工审核

---

### Coder Agent
**进行中**：重构 Provider Adapter，预计今天完成
**计划**：完成后跑单元测试，通过则提交 PR

### Ops Agent
**进行中**：部署 Telegram Bot，等待用户提供 Token
**计划**：部署完成后自动跑回归测试

### Explorer Agent
**进行中**：无
**计划**：无
```

### 编辑规则

- **目标** 和 **需要用户处理**：全局区域，任何 Agent 可追加，人类可修改排序和优先级。
- **Agent 分区**：每个 Agent 只读写自己的区域，不动别人的。
- **并发写入**：通过文件锁（与 Write/Edit 工具的锁一致）保证不会同时写。

### Agent 间的可见性

备忘录也是 Agent 之间的协作协议。每个 Agent 能看到备忘录全文（包括其他 Agent 的分区），但只暴露结论和状态，不暴露过程。

```
Agent A 能看到的：
  ✓ 备忘录全文（包括其他 Agent 的分区）
  ✓ 自己的 Session 上下文
  ✓ 自己的身份记忆 + 全局身份记忆

Agent A 看不到的：
  ✗ 其他 Agent 的 Session 上下文
  ✗ 其他 Agent 的身份记忆
```

如果 Agent A 需要 Agent B 的详细信息（如调研结果），应通过任务编排的 SubAgent 依赖关系传递，而不是直接访问对方上下文。

---

## 保密箱

保密箱统一管理所有凭证（API Key、OAuth Token、Secret 等）。核心规则：**AI 可以用，不可以输出。**

### 存储

凭证存储在加密文件 `.zero/secrets.enc` 中，该文件加入 `.gitignore`，不进版本控制。

加密方式：使用 AES 加密，主密钥存储在 macOS Keychain 中。

```
macOS Keychain
  └─ 主密钥（唯一存入 Keychain 的内容）
       │
       └─ 加解密 .zero/secrets.enc
              │
              ├─ anthropic_api_key          # API Key（api_key 类型）
              ├─ anthropic_oauth_token      # Anthropic OAuth Token（oauth_token 类型）
              ├─ chatgpt_oauth_token        # ChatGPT OAuth Token（oauth_chatgpt 类型）
              ├─ openai_api_key
              ├─ deepseek_api_key
              ├─ feishu_app_secret
              ├─ telegram_bot_token
              └─ ...
```

每条凭证除了值本身，还存储元数据：

```yaml
# secrets.enc 解密后的逻辑结构
anthropic_api_key:
  value: "sk-ant-api-..."
  type: api_key                  # api_key | oauth_token | oauth_chatgpt
  created_at: "2026-02-27T10:00:00Z"

anthropic_oauth_token:
  value: "sk-ant-oat-..."
  type: oauth_token
  created_at: "2026-02-27T11:00:00Z"
  expires_at: "2026-04-27T11:00:00Z"   # OAuth Token 有过期时间

chatgpt_oauth_token:
  value: "eyJ..."
  type: oauth_chatgpt
  created_at: "2026-02-27T12:00:00Z"
  expires_at: "2026-03-27T12:00:00Z"   # OAuth Token 可能有过期时间
```

系统启动时用主密钥解密到内存，运行期间从内存读取，磁盘上始终是密文。

### 输出过滤

AI 在所有输出场景（聊天回复、日志、记忆写入）中自动过滤密钥值，防止泄露。

---

## 记忆模块

记忆模块位于 `.zero/memory/`，使用 Markdown + 双向链接管理历史信息。

### 目录结构

1. `memory.md`：全局索引页。
2. `sessions/`：一次任务全过程。
3. `incidents/`：故障案例。
4. `runbooks/`：可重复执行流程。
5. `decisions/`：架构和策略决策。
6. `preferences/`：身份记忆（`global.md` + `agents/` 各 Agent 身份）。
7. `notes/`：用户主动保存内容。
8. `inbox/`：待整理原始记录。
9. `archive/`：归档数据。

### 记忆模板（统一最小字段）

每条记忆建议包含：

1. `id`
2. `type`
3. `title`
4. `created_at`
5. `updated_at`
6. `status`
7. `session_id`（全局页如 `memory.md` 可为空或 `global`）
8. `confidence`（0~1，用于自动化决策门槛）
9. `tags`
10. `related`

### 模型如何使用记忆

记忆分两层加载，模型只能"看到"被塞进上下文的内容：

**第一层：身份记忆（每次 Agent 启动固定加载）**

身份记忆分两级，Agent 启动时合并加载：

```
Agent 加载的身份记忆 = 全局身份 + 当前 Agent 身份 + 备忘录
```

- **全局身份**：所有 Agent 共享，包含用户偏好、沟通语言、基本信息。
- **Agent 身份**：每个 Agent 特有的上下文，如技术栈、工作流程、输出风格。
- **备忘录**（`.zero/memory/memo.md`）：当前目标、各 Agent 状态、待处理事项。

存储结构：

```
preferences/
  global.md          # 全局身份：用户偏好、语言、基本信息
  agents/
    coder.md         # 代码 Agent：技术栈、代码风格、项目上下文
    ops.md           # 运维 Agent：服务器配置、部署流程
    writer.md        # 写作 Agent：文风、目标受众
    explorer.md      # 调研 Agent：信息来源偏好、输出格式
```

Agent 身份记忆支持自我进化：Agent 在工作中发现新的偏好或模式时，可自行更新自己的身份记忆文件。

**第二层：工作记忆（按需检索）**

用户发消息后，通过一次**独立的单轮调用**判断是否需要历史上下文。该调用不占用主 Session 上下文。

```
用户发消息
  │
  ▼
┌──────────────────────────────┐
│  记忆检索（独立单轮调用）      │
│  输入：用户消息 + 身份记忆     │
│  输出：相关记忆片段（或空）     │
│  - 不进入主 Session 上下文    │
│  - 可使用更便宜的模型          │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  主 Session                   │
│  上下文 = 身份记忆             │
│         + 检索到的记忆片段     │
│         + 对话历史             │
│         + 用户消息             │
└──────────────────────────────┘
```

检索时的过滤条件：

- `status = verified`
- `confidence >= 阈值`
- 语义匹配（Embedding）+ Tag 过滤
- 返回 Top N 条最相关结果

### 记忆的写入

写入管线与读取管线对称——两条读取路径（固定加载 + 按需检索）对应两条写入路径。Prompt 和拦截机制的设计见 [ContextEngineering - 记忆写入的上下文处理]，实现代码见 [TechStack - 记忆写入实现]。

#### 双路径模型

```
事件发生
  │
  ▼
┌──────────────────────────────────────┐
│  事件分类器                            │
│  判断：这条信息未来会被怎么读？         │
│                                       │
│  每次都要看到 → Path A（改文件）       │
│  相关时才需要 → Path B（记忆入库）     │
│  不需要再看   → 不写记忆（仅留日志）   │
└──────┬────────────────────┬──────────┘
       │                    │
       ▼                    ▼
    Path A               Path B
    写文件               记忆入库
  （立即生效）        （检索时生效）
```

**Path A：身份记忆写入（直写文件 → 供固定加载读取）**

- 目标文件：3 个且仅 3 个
  - `preferences/global.md`（用户偏好、全局约束）
  - `preferences/agents/{name}.md`（Agent 行为模式、技术栈）
  - `memo.md`（当前目标、任务状态、待办）
- 操作类型：追加（append）/ 更新段落（update section）/ 删除段落（remove section）
- 写入时机：**实时**。Path A 的读取是"每轮固定加载"，延迟写入会导致同 Session 内信息不一致（用户说了"以后用英文注释"，但后续代码仍用中文注释）
- 触发方式：
  - 框架层拦截：用户说"记住 X"、"以后 X"等简单模式，框架自动写入并通知 Agent（格式见 [ContextEngineering - 框架层写入拦截]）
  - Agent 工具调用：需要推理的复杂写入（如"把之前那个方案记录下来"），Agent 通过 MemoryWrite 工具执行

**Path B：工作记忆写入（记忆入库 → 供按需检索读取）**

- 目标目录：`sessions/`、`incidents/`、`runbooks/`、`decisions/`、`notes/`
- 多层一致写入（每次写入同时维护）：
  1. Markdown 文件（人类可读展示层）
  2. 向量索引（语义检索层，读取端 `executeRetrieval` 依赖此索引）
  3. Tag 索引（精确过滤层，读取端 `status`/`confidence` 过滤依赖此索引）
  4. `memory.md` 全局索引（索引页，供人工和系统浏览）
- 写入时机：**实时**。新写入的低 confidence + draft 状态条目对读取端不可见（读取端过滤 `status = verified` + `confidence >= 0.6`），因此实时写入不会污染检索结果
- 一致性保证：事务性写入，任一层失败则尝试全部回滚。回滚本身也可能失败（磁盘故障、进程崩溃等），此时记录错误日志并标记该记忆为 `corrupted`，由 `memory_cleanup` 定时任务检测并修复不一致状态（实现见 [TechStack - 事务性多层写入]）

#### 事件分类器

大部分事件的路由是确定性的，无需模型调用。仅 `user_request` 和 `agent_discovery` 等模糊事件需要便宜模型单轮判断。

| 事件类型 | 路径 | 目标 | 路由方式 |
|----------|------|------|----------|
| `task_status_change` | A | memo.md Agent 分区 | 确定性 |
| `user_correction` | A | preferences/agents/{name}.md | 确定性 |
| `user_preference` | A | preferences/global.md | 确定性 |
| `error_recurring` | B | incidents/ | 确定性 |
| `fix_verified` | B | runbooks/ | 确定性 |
| `architecture_choice` | B | decisions/ | 确定性 |
| `user_request` | A 或 B | 视内容而定 | 便宜模型判断 |
| `agent_discovery` | A 或 B | 视内容而定 | 便宜模型判断 |
| `session_end` | A + B | 跨路径 | 确定性（走 Session 结束流） |
| `session_interrupt` | A + B | 跨路径 | 确定性（走中断处理流） |

分类 Prompt 定义见 [ContextEngineering - 事件分类 Prompt]。

#### Path A 写入约束

**容量执行**：Path A 文件有预算硬上限（对应 [ContextEngineering - 上下文预算管理] 中的固定预算分配）。写入前检查目标文件 token 数：

- `> 100%` 容量上限 → **拒绝写入**，返回错误提示需先整理。拒绝比截断好——截断是静默丢失信息，拒绝能让 Agent 知道需要先清理。
- `> 90%` 容量上限 → 写入但发出系统通知（`<system_notice>`）警告容量即将满。

**Memo 并发控制**：

- 使用与 Write/Edit 工具相同的文件锁，保证不会同时写入。
- Agent 只能写自己的分区（Section 权限校验），全局区域（目标/需要用户处理）任何 Agent 可追加。
- 两个 Agent 同时追加全局区域时：文件锁串行化，后者基于前者结果追加。

#### Path B 写入约束

**inbox 暂存区**：不确定最终分类的事件先写入 inbox：

- 默认 `confidence: 0.3` + `status: draft`
- 读取端过滤条件（`status = verified` + `confidence >= 0.6`）会自动屏蔽 inbox 条目
- inbox 条目在 Session 结束时审查，或由 Scheduler 定期清理任务处理

**去重检查（写入前执行）**：

对新内容做 Embedding，与现有记忆做相似度比较，三级阈值判断：

| 相似度 | 判定 | 处理 |
|--------|------|------|
| > 0.98 | 重复（duplicate） | 合并到已有记忆，记录 merge_history |
| 0.85 ~ 0.98 | 灰色区间 | 便宜模型二次判定：duplicate / related / different |
| < 0.85 | 不同（different） | 正常写入 |

判定为 `related` 时不合并，但尝试互相添加到 `related` 字段（双向链接），方便后续检索时关联推荐。关联写入是 best-effort：主记录创建成功后才尝试建立关联，关联失败不影响主记录，失败的关联由 `memory_cleanup` 定时任务补建。实现见 [TechStack - 跨 Session 去重]。

**Confidence 升级与自动验证**：

- 重复出现的信息 → confidence +0.1（合并时累加）
- 自动验证条件：`confidence >= 0.7` **且** 被 `>= 2` 个不同 Session 确认 → `status` 从 `draft` 自动升级为 `verified`
- 单次出现的事件保持 `draft`，不会污染检索结果

**合并历史追踪**：

每次合并在 Markdown 文件的 Frontmatter 中记录 `merge_history`，包含来源 Session ID、合并时间、confidence 变化。用于事后审计和回溯。

#### Session 结束写入流（跨路径）

Session 结束是最复杂的写入场景，同时触发两条路径：

```
Session 正常结束
  │
  ▼
生成 Session 分析（便宜模型单轮调用）
  │
  ├──→ Path B: 写入 session 总结
  │     status: verified, confidence: 0.8
  │
  ├──→ Path B: 提炼知识条目
  │     incident/runbook/decision
  │     status: draft, confidence: 0.6
  │     （需后续重复确认或人工审核才可 verified）
  │
  ├──→ Path A: 清理 memo 中已完成任务的条目
  │
  ├──→ Path A: 更新 preferences
  │     （如果 Session 中用户纠正了 Agent 行为）
  │
  └──→ Path B: 审查本 Session 的 inbox 条目
        → 与 session 分析交叉验证
        → 通过验证 → promote（提升 confidence）
        → 无价值 → discard
```

Session 分析由便宜模型生成（不占用主 Session 上下文），输出结构化的分析结果：总结、可提炼知识、行为纠正记录、可清理的 memo 条目。实现见 [TechStack - Session 结束写入流]。

#### Session 异常中断

进程崩溃、超时、用户强制中止时的处理：

- **Path B**：写入部分总结。`status: draft`，`confidence: 0.5`。数据可能不完整，但尽最大努力保存已有进度。
- **Path A**：在 memo 中标记中断状态（`**中断**：Session {id} 因 {reason} 中断，任务未完成`）。**不清理 memo 条目**——下次 Agent 启动时看到中断标记，可以决定是否继续。

### 记忆整理

整理流程与写入管线集成：

1. **inbox 处理**（两个时机）：
   - Session 结束时：审查本 Session 产生的 inbox 条目，与 session 分析交叉验证后 promote 或 discard。
   - Scheduler 定期任务（`memory_cleanup`，每周日 3:00）：清理积压的 inbox 条目，处理跨 Session 的残留数据。

2. **跨 Session 去重**（持续进行）：
   - Path B 每次写入前自动执行去重检查，这是一个持续的整理行为而非事后批处理。
   - 合并时记录 merge_history，更新 confidence，必要时自动升级 status。

3. **归档**：
   - 过期或低价值内容移入 `archive/`（归档评分见 [容量管理]）。
   - 归档时从向量索引和 Tag 索引中移除，仅保留 Markdown 文件用于人工查阅。

4. **索引同步**：
   - 每次写入/合并/归档后更新 `memory.md` 索引链接。
   - 多层存储（Markdown + 向量 + Tag + 索引）通过事务性写入保持一致。

5. **一致性修复**：
   - `memory_cleanup` 定时任务扫描 `corrupted` 状态的记忆条目（写入事务回滚失败时标记）。
   - 对比多层存储的实际状态，清理残留的不一致数据（如 Markdown 存在但向量索引缺失，或反之）。
   - 补建写入失败的 related 双向链接。

### 容量管理

#### Path A 文件容量

Path A 文件的容量上限与 System Prompt 的固定预算直接对应（[ContextEngineering - 上下文预算管理]）：

| 文件 | 容量上限 | 对应预算分区 |
|------|---------|-------------|
| `preferences/global.md` | 1,000 tokens | `budget.identity` 的全局部分 |
| `preferences/agents/{name}.md` | 2,000 tokens | `budget.identity` 的 Agent 部分 |
| `memo.md` | 1,500 tokens | `budget.memo` |

写入前执行容量检查：
- `> 100%` → 拒绝写入（需先整理）
- `> 90%` → 写入但发出容量警告

#### 总记忆容量

| 维度 | 上限 | 说明 |
|------|------|------|
| 活跃记忆条数 | 1,000 条 | `status` 为 `draft` 或 `verified` 的条目总数 |
| 单条记忆正文 | 2,000 tokens | 不含 Frontmatter 元数据 |

自动归档评分公式：

```
score = confidence × recency_weight(last_accessed_at)
recency_weight = 1 / (1 + days_since_last_access / 30)
```

`score` 低于阈值（默认 0.2）的记忆自动移入 `archive/`。归档操作同步清理向量索引和 Tag 索引。

### 冲突解决

#### 记忆矛盾

当多条记忆出现矛盾时，按以下优先级决策：

1. `confidence` 更高的优先。
2. `updated_at` 更新的优先。
3. 无法自动决策时标记冲突，等待用户裁决。

#### 去重合并冲突

当去重判定为 `duplicate` 时，合并策略：

1. 合并目标固定为已有条目（保持 ID 稳定，已有的链接、引用和 merge_history 不中断）。
2. confidence 取两者较大值再 +0.1（合并不降级，确保高 confidence 的信息不因合并而被稀释）。
3. 将被合并条目的 Session ID 追加到 `merge_history`。
4. 内容合并：用便宜模型将两者内容去重 + 补充，限制在 400 tokens 内。合并不偏向任何一方，保留所有互补信息。

#### Memo 并发冲突

- 通过文件锁避免并发写入冲突（与 Write/Edit 工具的锁一致）。
- Section 权限保证 Agent 只能写自己的分区。
- 多个 Agent 同时追加全局区域时，文件锁串行化——后者基于前者的最新内容追加。

### 检索机制

1. 对记忆内容做 Embedding，维护向量索引，支持语义检索。
2. 维护结构化 Tag 索引（JSON/SQLite），支持精确过滤。
3. Markdown 文件作为人类可读的展示层，底层由结构化存储驱动。

---

## 观测性

系统的所有操作统一通过结构化事件、Metrics 和 Trace 进行记录，既用于安全策略中的事后排查，也用于 AI 自身的诊断和自我修复。

第一阶段中，观测层采用“全局事件流 + Session Trace + specialized ledgers”并存的形态：

1. 全局 `events.jsonl` 负责轻量事件流。
2. 每个 Session 新增独立的 `trace.jsonl`，持久化 span 级执行追踪。
3. `requests.jsonl`、`snapshots.jsonl`、`closure.jsonl` 继续保留为 specialized ledgers，但不再是 Session runtime 的主写入目标。
4. 当前实现中，Session 级读取优先使用 `trace.jsonl` 投影；specialized ledgers 主要承担历史兼容与 fallback 作用。

日志存储在 `.zero/logs/` 目录下，使用 JSONL 追加写入，SQLite 做聚合查询：

```
.zero/logs/
  ├─ events.jsonl          # 全局系统事件流（追加写入）
  ├─ requests.jsonl        # 全局 LLM 请求记录（legacy fallback）
  ├─ notifications.jsonl   # 通知记录（追加写入）
  ├─ metrics.db            # SQLite 聚合查询
  ├─ sessions.db           # SQLite Session 持久化
  ├─ supervisor.log        # Supervisor 标准输出
  ├─ supervisor.error.log  # Supervisor 错误输出
  └─ sessions/             # 按 Session 分区的日志
      └─ {sessionId}/
          ├─ trace.jsonl     # 该 Session 的执行 Trace（span 记录）
          ├─ requests.jsonl  # 该 Session 的 LLM 请求台账
          ├─ snapshots.jsonl # 该 Session 的上下文快照台账
          └─ closure.jsonl   # 该 Session 的任务关闭台账
```

### 结构化日志

全局事件流写入 `events.jsonl`，每条包含：

```json
{
  "ts": "2026-02-27T10:05:00Z",
  "level": "info",
  "sessionId": "sess_001",
  "event": "tool_call",
  "tool": "bash",
  "outputSummary": "listed 12 files",
  "durationMs": 45
}
```

### Metrics

从 JSONL 日志异步聚合到 `metrics.db`（定期批量刷入，非实时写入），持续收集核心指标：

1. 任务成功率 / 失败率。
2. 平均执行时间。
3. 自我修复触发次数和成功率。
4. 各模型的 Token 用量和费用（按模型、Provider、Session、时间维度）。
5. 工具调用频率和错误率。
6. 缓存命中率（cache_read / 总 input tokens）。

### Trace

复杂任务记录完整调用链：Session / Turn → LLM Request → Tool Call → SubAgent → Snapshot / Closure。用于事后分析、性能定位和 Runbook 生成。

Trace 以 Session 为粒度写入 `sessions/{sessionId}/trace.jsonl`，每条都是一个已结束的 span，至少包含 `spanId`、`parentSpanId`、`kind`、`startTime`、`endTime` 和 `durationMs`。

```jsonl
{ "spanId": "span_01", "parentSpanId": null, "sessionId": "sess_001", "kind": "turn", "name": "turn:web", "startTime": "2026-02-27T10:00:00Z", "endTime": "2026-02-27T10:00:03Z", "durationMs": 3000, "status": "success" }
{ "spanId": "span_02", "parentSpanId": "span_01", "sessionId": "sess_001", "kind": "llm_request", "name": "llm_request", "startTime": "2026-02-27T10:00:00Z", "endTime": "2026-02-27T10:00:02Z", "durationMs": 1820, "status": "success", "data": { "model": "claude-sonnet" } }
{ "spanId": "span_03", "parentSpanId": "span_02", "sessionId": "sess_001", "kind": "tool_call", "name": "tool:bash", "startTime": "2026-02-27T10:00:02Z", "endTime": "2026-02-27T10:00:03Z", "durationMs": 45, "status": "success", "data": { "tool": "bash" } }
```

`requests.jsonl`、`snapshots.jsonl`、`closure.jsonl` 在当前阶段继续作为专用台账保留，不并入 `trace.jsonl`。Trace 负责骨架和因果链，并已成为 Session 级读取与主写入的优先数据源；specialized ledgers 主要保留给历史兼容、迁移和 fallback 读取。

---

## 通知

通知策略不是"只在完成时通知"，而是"有进展就通知"，尤其是：

1. 需要用户授权。
2. 需要验证码或扫码。
3. 自动重试多次失败。
4. 触发熔断或回滚。
5. 模型降级切换。

### 通知与对话共存

在 IM 场景中，通知和用户对话在同一个聊天窗口内。通知作为上下文的一部分，AI 可以感知和回应。

消息通过 `type` 字段区分：

```
Session 上下文：

  [type: message]       用户：帮我改一下 config
  [type: message]       AI：好的，已修改
  [type: notification]  📋 定时任务：系统更新检查，发现新版本 v1.2.3
  [type: message]       用户：刚才那个更新是什么情况
  [type: message]       AI：刚才定时任务检测到新版本 v1.2.3，主要更新了...
```

- `type: message` — 正常对话。
- `type: notification` — 系统通知，在 IM 端用卡片样式渲染，视觉上与对话区分。

通知不需要隔离，也不需要创建独立 Session。它就是当前上下文的一部分，用户随时可以追问。

### Channel

> 长连接，用于即时通知和交互。如飞书机器人、Telegram 机器人、钉钉机器人等。

Channel 支持**双向交互**：不仅推送通知，用户也可通过 Channel 下达指令、审批授权、回答确认问题。

内置 Channel（飞书、Telegram、Web）在源码 `packages/channel` 中，随版本管理。允许 AI 自建新的 Channel，扩展代码放在 `.zero/channels/` 目录下（运行时扩展目录），以便用户审查和管理权限。

示例：接入飞书机器人

1. 读取官方 API 文档。
2. 构建连接工具和监听服务。
3. 向用户申请 `App ID` / `App Secret`。
4. 凭证存入保密箱，仅在授权后可调用。

---

## Session

Session 是多轮对话的载体，也是任务执行的载体。每个 Session 在 Memory 中形成一条记录，包含上下文和总结。

在 IM 场景中，一个聊天窗口对应一个 Session。多个 IM 窗口（飞书私聊、Telegram 对话等）同时活跃时，各自运行独立的 Session，互不干扰。

### 生命周期

1. **创建**：用户发消息、Scheduler 触发、或系统自动创建。
2. **执行**：AI 根据上下文执行任务，期间不断更新 Session 记录。所有消息（对话 + 通知）都在同一上下文中。
3. **结束**：任务完成或空闲超时，生成总结并提炼记忆。
4. **归档**：过期或不再需要的 Session 移入 archive。
5. **查询**：用户可随时查询历史 Session，查看总结和相关记忆。

### 重启安全

进程收到 `SIGTERM` / `SIGINT` 或执行 `bun zero restart` 时，不会立即中断当前 turn：

1. **优雅排空（Graceful Drain）**：系统先拒绝新的聊天消息，但保持 Channel 连接和心跳写入，等待当前活跃 turn 尽量完成。
2. **中断记录（Restart Sentinel）**：只有在 drain 超时后仍未完成、确实会被重启打断的 Session，才会写入 `.zero/restart-sentinel.json`。
3. **启动恢复**：新进程启动后读取该哨兵，为这些被中断的 Session 注入一次恢复提示，继续未完成的任务。

### Session 数据结构

```yaml
session:
  id: "sess_20260227_001"
  created_at: "2026-02-27T10:00:00Z"
  source: "feishu"              # 触发来源：feishu / telegram / scheduler / web
  current_model: "claude-opus"
  model_history:
    - model: "claude-sonnet"
      from: "2026-02-27T10:00:00Z"
      to: "2026-02-27T10:05:00Z"
    - model: "claude-opus"
      from: "2026-02-27T10:05:00Z"
      to: null
```

### 支持命令

1. `/new [model]` — 创建新 Session，可选指定模型。
2. `/model [model]` — 携带参数则切换当前 Session 使用的模型；不携带参数则返回当前模型名称。
3. `/session` — 返回当前 Session 的基础信息、时间范围、消息统计、工具调用次数和 token/费用汇总。

---

## 版本管理

所有变更纳入 Git 管理，支持可靠的回滚和审计。

1. ZeRo OS 自身代码通过 Git 管理，每次自我修改自动 Commit。
2. 每个 Tool/SKILL 有版本号，升级不兼容时可回退。
3. 配置变更同样纳入版本控制。
4. 成功启动并稳定运行超过设定时间后，自动打 Tag 标记为 `stable`。
5. 回滚操作等价于 `git revert` 到最近的 `stable` Tag。

---

## 自我修复

自我修复分为两个独立单元（详见 [TechStack - Supervisor 与 Health 的职责划分]）：

### 保活机制（Supervisor，独立进程）

1. 使用 `LaunchAgent`（用户级服务）保活 `Supervisor`。用户登录后自动启动，锁屏和睡眠期间持续运行，Keychain 保持可用。
2. 主程序每 10 秒写一次心跳。
3. `Supervisor` 每 20 秒检查心跳更新时间。
4. 超过 50 秒未更新，判定主程序失活。
5. `Supervisor` 是极简看门狗，不依赖主进程的任何内部模块。

### 优雅关闭与重启恢复

主进程收到终止信号时按以下顺序处理：

1. 标记 `shuttingDown`，拒绝新的用户消息与新的聊天 turn。
2. 停止 Scheduler 触发新的任务，但保持现有 Channel 连接和心跳写入。
3. 等待当前活跃 turn 尽量完成；若超时，记录仍被中断的 Session 到 `restart-sentinel.json`。
4. 关闭 Channel，停止心跳，flush Session 状态，关闭数据库并退出。
5. 新进程启动后读取 sentinel，仅恢复那些确实因重启被打断的 Session。

### 修复流程（Health，主进程内部）

主进程活着但遇到错误时，由内部 Health 模块编排修复流程：

检测 → 诊断 → 修复 → 验证 → 重启 → 观察。

### 修复边界（Health 模块）

AI 可自主执行所有修复操作，包括重启进程、回滚版本、清理文件、重装依赖、修改代码等。仅受熔断名单约束。

### 熔断机制（双层）

**Health 模块层**：连续 N 次修复失败后触发熔断：

1. 锁定系统，停止自动修复。
2. 回滚到最近 `stable` 版本。
3. 通知用户介入。
4. 写入 `incidents/` 记录完整的故障诊断链。

**Supervisor 层**：连续 N 次重启主进程失败后触发熔断：

1. 回滚到最近 `stable` Tag。
2. 尝试重启回滚后的版本。
3. 仍然失败则停止重启，通知用户。

### 诊断知识来源

修复流程依赖记忆模块中的结构化知识：

1. `incidents/` 提供历史故障的匹配参考。
2. `runbooks/` 提供可执行的修复步骤。
3. 仅 `verified` 且 `confidence >= 0.8` 的 Runbook 可用于自动修复。
