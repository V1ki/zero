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
- ChatGPT Codex provider 登录成功后会按账号和 transport 自动发现并验证模型；结果缓存在
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
