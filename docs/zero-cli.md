# Zero CLI 手册

这份文档是当前仓库中对 Agent 暴露的 Zero CLI 受控手册。

规则只有两条：

1. 涉及 `bun zero` 或 Zero 运维命令时，先读这份文档，再决定执行哪个命令。
2. 只使用本文明确列出的命令；不要主动建议或执行未列出的 Zero 命令。

## 入口

统一入口：

```bash
bun zero <command>
```

当前对 Agent 暴露的命令分组：

- 运行控制：`start`、`restart`、`status`
- 日志查看：`logs`
- Secret 管理：`secret set`、`secret list`、`secret delete`
- 微信接入：`weixin login`
- GitHub App：`github identity`、`github reply`、`github open-pr`、`github merge`
- macOS 守护进程：`launchctl install`、`launchctl status`、`launchctl uninstall`

## 运行控制

### `bun zero start`

用途：启动 ZeRo OS 主进程，并在 core ready 后挂起 Web UI。

真实行为：

- 启动前会检查 `.zero/config.yaml` 是否存在
- 配置缺失时直接失败，不会自动初始化
- 进程启动后会注册 `SIGINT` / `SIGTERM` 的优雅关闭

使用场景：

- 本地启动 runtime
- 验证服务是否能正常拉起
- 配合 `status`、`logs` 做故障排查

示例：

```bash
bun zero start
```

### `bun zero restart`

用途：优雅重启当前运行中的主进程。

真实行为：

- 依赖 `.zero/heartbeat.json` 判断当前是否有可重启进程
- 若进程刚启动且仍处于 15 秒 grace period，会拒绝重启
- 重启前会先执行 Web UI rebuild；build 失败则取消重启
- 成功时向当前 PID 发送 `SIGTERM`，由 supervisor 接手拉起新进程

使用场景：

- 更新配置或前端构建后需要平滑重启
- OAuth 或运行态配置更新后切换到新状态

示例：

```bash
bun zero restart
```

### `bun zero status`

用途：查看当前本地运行环境的关键状态。

输出重点：

- `.zero/config.yaml` 是否存在
- `.zero/secrets.enc` 是否存在
- macOS Keychain 主密钥是否可读
- `openai_codex_api_key` 是否已配置
- ChatGPT / Claude / X Premium OAuth 凭证是否已存在于 vault
- `.zero/logs` 是否存在
- `apps/web/dist` 是否已构建
- macOS 下的 LaunchAgent 安装和加载状态

适合场景：

- 启动失败前的环境自检
- restart 之前确认 heartbeat / logs / vault 状态
- 远程指导他人排查环境问题

示例：

```bash
bun zero status
```

## 在 GitHub 上回复 Issue 或 PR

从 ZeRo 项目目录执行，目标仓库须已开启监听并绑定 GitHub App。先在文本文件中写好完整评论，再指定仓库和 Issue 或 PR 编号发送。

```bash
bun zero github reply --repo V1ki/dsh-plugin-subscriptions --number 157 --body-file ./reply.md
```

命令以该仓库的 App 身份在讨论区发布一条普通评论，并打印作者和评论链接。发出后如果显示投递结果不确定，先打开该讨论核对，避免重复发送。Issue 评论使用安装的 Issues 写权限；PR 讨论评论还需安装已批准的 Pull requests 写权限，ZeRo 会把该权限一并放入评论令牌。日常监听使用只读令牌。`identity` 显示的是安装权限，具体写请求仍以 GitHub 回执为准。

### 核对身份与合并 PR

从 ZeRo 项目目录运行 `bun zero github identity --repo OWNER/REPO` 可读取该仓库安装的机器人名称，以及发表评论、合并 PR 所需的安装权限。分支保护、审核状态和待合并版本还需在具体 PR 上核对。

已推送的分支可以用 `bun zero github open-pr --repo OWNER/REPO --head BRANCH --base BASE --title TITLE --body-file PATH` 创建 PR。PR 由仓库绑定的 GitHub App 署名，安装需要 Pull requests 写权限。若同一分支已有开放 PR，返回现有链接和实际作者。

本地已验证的提交可用 `bun zero github publish-branch --repo OWNER/REPO --source PATH --branch BRANCH --head SHA` 发布到目标仓库的 PR 分支。PATH 可指向 Git 工作副本或包含该提交的 bundle。工具使用绑定 App 的 Contents 写权限，保留原提交和作者，并回读远端提交号。贡献者分支不可写时，可以在目标仓库发布候选，替代 PR 应链接原讨论并保留贡献者署名。

审阅当前改动和验证结果后，已获准的简单 PR 可以使用 `bun zero github merge --repo OWNER/REPO --number N --head SHA` 合并，SHA 填入已审查的完整提交号。复杂 PR 先由用户确认具体提交。命令以安装身份向 GitHub 提交版本条件，随后回读合并者、提交和链接。已合并的 PR 返回原回执。缺少 Contents 写权限时，向 Router 说明该仓库 App 的权限缺口。

## 日志查看

### `bun zero logs [target] [--lines <n>] [--follow]`

用途：查看 supervisor 标准输出和错误日志。

支持的 target：

- `supervisor` 或 `out`：只看 `.zero/logs/supervisor.log`
- `error` 或 `err`：只看 `.zero/logs/supervisor.error.log`
- `all`：同时看两个文件；默认 target

参数：

- `--lines <n>` 或 `-n <n>`：显示最近多少行，默认 `100`
- `--follow` 或 `-f`：持续追踪日志输出

真实行为：

- 如果目标日志文件尚不存在，会提示未找到日志文件
- 非 follow 模式下使用 `tail -n`
- follow 模式下使用 `tail -f`

常用示例：

```bash
bun zero logs
bun zero logs all --follow
bun zero logs error -n 200
bun zero logs out -f
```

## Secret 管理

### `bun zero secret set <key> <value>`

用途：把一个 secret 写入加密 vault。

真实行为：

- 依赖 macOS Keychain 中的主密钥
- 若还没有主密钥，命令会失败
- 值会写入 `.zero/secrets.enc`，不要手改该文件
- 运行中的 Zero server 会在后续读取或写入 vault 时自动检测磁盘更新，外部 `secret set` 不会再被下一次 OAuth refresh 静默覆盖
- 如果某个组件在启动时就把凭据解析成了长期存活的运行时对象，补写全新 secret 后仍建议重启一次 `bun zero restart`

示例：

```bash
bun zero secret set openai_codex_api_key <value>
```

## Provider OAuth

### `bun zero provider login <provider> [--name <name>]`

用途：通过托管 OAuth 流程连接 ChatGPT、Claude 或 X Premium provider。

支持的 provider：

- `chatgpt`
- `anthropic`
- `x-premium`

真实行为：

- 不带 `--name` 时保持旧行为，例如写入 `chatgpt` / `chatgpt_oauth_token`
- 带 `--name` 时创建独立 provider 实例，例如 `chatgpt-work` 和 `chatgpt_oauth_work`
- 如果本地 Web server 正在运行，登录成功后会尝试热重载 model provider 配置
- ChatGPT Codex 和 Anthropic provider 登录成功后会按账号和 transport 自动发现并验证模型；结果缓存在
  `.zero/cache/model-catalog/catalog.json`
- 多个订阅发现相同 `model_id` 后，会自动组成 `pool/<model_id>`；provider 配置顺序决定初始优先级
- 自动发现失败不会清空已验证缓存或手工模型；配置页 Models 标签可手动执行 `Refresh models`
- 如果热重载不可达，配置和 vault 仍会保存；下次启动或重启后生效
- CLI 只有在成功生成并打印授权 URL 后，才会在浏览器回调超时时提示手工粘贴；OIDC discovery 等初始化失败会直接显示真实错误
- X Premium 的 OIDC discovery、code exchange 和 token refresh 使用 15 秒超时；同一运行时内针对同一 vault 凭据的并发 refresh 会合并为一次请求
- 配置页发现已过期的托管 OAuth session 时会在后台尝试 soft refresh；refresh grant 失效时显示错误并保留 `Connect` 入口

示例：

```bash
bun zero provider login chatgpt
bun zero provider login chatgpt --name work
bun zero provider login anthropic --name max
```

自动 pool 使用 `sticky_quota_aware_failover`，在单个 session 内尽量固定实际 provider，只有遇到额度、认证或临时可用性问题时才切换。`.zero/config.yaml` 的 `model_pools` 只用于覆盖自动成员、顺序或策略，规范名称为 `pool/<model_id>`。

动态模型、逻辑 route、过滤器、刷新触发和 API 说明见
[`docs/model-catalog.md`](./model-catalog.md)。

### `bun zero secret list`

用途：列出当前 vault 中已保存的 secret key 名称。

注意：

- 只会列出 key，不会打印 secret value

示例：

```bash
bun zero secret list
```

### `bun zero secret delete <key>`

用途：从 vault 中删除指定 secret。

注意：

- 删除后需要重新写入才能恢复
- 这是有副作用的命令，执行前要确认 key 名称正确

示例：

```bash
bun zero secret delete openai_codex_api_key
```

## Weixin 接入

### `bun zero weixin login`

用途：通过 iLink Bot API 扫码登录一个微信个人号，并把凭据写入 vault。

真实行为：

- 在终端打印二维码的 URL 与原始 `qrcode=` 值；用户自行扫码确认
- 登录成功后把 `account_id` / `token` / `base_url` 分别写到 vault 的
  `weixin_<name>_account_id` / `weixin_<name>_token` / `weixin_<name>_base_url`
- `.zero/weixin/accounts/` 仅用于 sync cursor / context tokens 等运行态状态，
  CLI 登录不会在该目录写入 token
- 登录完成后会自动把对应条目 upsert 到 `.zero/config.yaml` 的 `channels` 数组

使用场景：

- 首次接入一个新的微信号
- 现有凭据失效后重新登录

示例：

```bash
bun zero weixin login --name personal-bot
```

配置示例（`.zero/config.yaml`）：

```yaml
channels:
  - type: weixin
    name: personal-bot
    accountIdRef: weixin_personal-bot_account_id
    tokenRef: weixin_personal-bot_token
    baseUrlRef: weixin_personal-bot_base_url
    # 可选：写入 iLink API 的 base_info.bot_agent，会按 OpenClaw 2.4.x 规则清洗
    botAgent: Zero/0.1
    dmPolicy: open
    groupPolicy: disabled
```

> ⚠️ Weixin 通道走腾讯 iLink Bot API。协议本身由腾讯官方为 OpenClaw 等 AI agent
> 开放，但 Zero 的实现不是官方签约客户端，协议变更时可能暂时失效。
> 当前实现按 `@tencent-weixin/openclaw-weixin` 的 direct-only 通道语义路由：
> 入站消息使用 `from_user_id` 作为会话 peer，`groupPolicy` 先保留为配置字段。
> 回复处理期间会发送 Weixin typing 状态，处理完成或出错后发送 cancel typing。

ZeRo 的收发协议对照腾讯微信插件 `2.4.10` 验证。微信把私聊的 `context_token` 随入站消息交给机器人。ZeRo 为该机器人和发件人保存最新值，供回复或主动提醒使用。机器人空闲时的收信轮询会更新读取进度，公开协议没有为机器人单独续签私聊凭据的接口。长时间未互动后遇到拒收，可以先给同一机器人发一条微信，再发起新的提醒。[腾讯微信插件协议](https://github.com/Tencent/openclaw-weixin/blob/v2.4.10/docs/protocol_zh_CN.md)

## macOS LaunchAgent

这组命令只适用于 macOS。

### `bun zero launchctl install`

用途：安装或更新 supervisor 对应的 LaunchAgent。

效果：

- 生成并注册 `com.zero-os.supervisor`
- 指向 `apps/supervisor/src/main.ts`
- 输出 plist 路径

### `bun zero launchctl status`

用途：查看 LaunchAgent 当前是否 installed / loaded。

输出重点：

- label
- installed
- loaded
- plist 路径
- 首行详情

### `bun zero launchctl uninstall`

用途：卸载 supervisor 的 LaunchAgent。

常用示例：

```bash
bun zero launchctl install
bun zero launchctl status
bun zero launchctl uninstall
```

## 推荐排查顺序

### 服务起不来

```bash
bun zero status
bun zero logs error -n 200
```

先确认配置、vault、logs、web build 是否就绪，再看错误日志。

### 服务已运行但需要平滑重启

```bash
bun zero status
bun zero restart
bun zero logs all --follow
```

先确认环境和 heartbeat，再执行重启，最后追日志验证是否已恢复。

### 怀疑是 secret 问题

```bash
bun zero secret list
bun zero status
```

只检查 key 是否存在，不要输出 secret value。

## Router 的 Codex 工作目录

已启用监听的仓库在第一次收到工程任务时，会通过本机 gh 创建专用工作副本，保存在 `~/.local/share/zero/router-checkouts/OWNER/REPO`。已有本地工作区时，可在 `.zero/config.yaml` 指定绝对路径；显式配置优先。修改配置后重启 ZeRo 生效。

```yaml
router:
  codex_checkouts:
    example/service:
      path: /Users/me/Projects/service-worker
```

网页和已验证为同一操作者的微信、钉钉、飞书私聊共用这份仓库配置。旧配置中的 `im_channels` 可移除。

启动或继续 Codex 工作前，ZeRo 会重新核对目录和本地 Git 配置中的 `origin`。使用 GitHub 的 HTTPS 或 SSH 地址和绝对目录，目录需为 Git 工作树根目录，并与 ZeRo 的运行数据分开。请为会写文件、执行项目代码的工程任务提供可信的专用工作副本。


Router 工程 Worker 在已映射工作区沿用本机 Codex 当前权限和工具配置，启动与恢复时均应用当前配置；不再额外禁用网络、MCP、插件和技能，或强制 `.git` 只读。配置的实际权限仍须与具体任务授权配合使用。


### Codex Worker 账号回退

`worker.codex_command` 和 `worker.codex_fallback_command` 接受程序及参数数组；程序直接启动，不经过 shell。默认入口返回明确的 `usageLimitExceeded` 时，使用备用入口继续原线程；普通 `rateLimitExceeded`、模型不支持、认证失败和连接中断不会触发账号回退。备用账号也没有额度时返回实际错误，不循环切号。配置同时用于普通 Worker 和 Router 工程 Worker，切换记录在 `worker_account_fallback` 日志中，按原 thread/turn 记录用量。

本机 `codex-ys` 是 `cm cli ys` 的 shell alias，`cm` 使用已安装的 account-kit Python 启动器。配置示意如下，路径应使用本机真实安装位置：

```yaml
worker:
  codex_command: ["/path/to/python3", "/path/to/account.py", "cli", "default"]
  codex_fallback_command: ["/path/to/python3", "/path/to/account.py", "cli", "ys"]
```

这两个入口需能访问同一份会话存储。切换使用原线程继续已有上下文，不复制凭据、不重建任务；若备用入口不能恢复线程，原样报告失败。已有 shell alias 不能直接当作可执行文件路径。
