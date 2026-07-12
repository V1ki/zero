# Runtime Model Catalog

Runtime Model Catalog 负责按 provider 实例、OAuth 账号和 API transport 自动发现可用模型。现有
`.zero/config.yaml` 中的手工模型继续有效，并对同名或同 `model_id` 的动态模型拥有最高优先级。

这里的 provider 表示一个订阅/凭据实例；模型厂商类型由 managed OAuth kind 和 discovery driver
表达。例如 `chatgpt` 和 `chatgpt-personal` 是两个独立订阅，它们都通过同一个 ChatGPT driver 发现模型。

首个 discovery driver 支持 ChatGPT Codex transport：

- provider 名为 `chatgpt`，或 `managed_oauth_provider: chatgpt`
- `api_type: openai_responses`
- `base_url` 以 `/backend-api/codex` 结尾

ChatGPT Web 模型名不会映射到 Codex transport。目录中可见的模型必须通过一次最小 Responses
调用，状态达到 `verified` 后才会进入 Registry 和自动路由。

## 配置

```yaml
providers:
  chatgpt:
    api_type: openai_responses
    base_url: https://chatgpt.com/backend-api/codex
    auth:
      type: oauth2
      oauth_token_ref: chatgpt_oauth_token
      managed_oauth_provider: chatgpt
    discovery:
      enabled: true
      refresh_interval_ms: 21600000
      timeout_ms: 30000
      # 可选；默认按当前年月生成兼容版本号
      client_version: 2026.7.0
      allow:
        - gpt-*
      deny:
        - '*-preview'
    models:
      # 手工条目是 override，也可作为启动和发现失败时的回退。
      gpt-stable:
        model_id: gpt-5.5
        max_context: 400000
        max_output: 128000
        capabilities: [tools, vision, reasoning]
        tags: [manual, stable]

model_routes:
  coding-latest:
    providers: [chatgpt]
    family: gpt
    lanes: [sol, terra]
    requires: [tools, reasoning]
    min_context: 200000
    prefer: quality
    reasoning_effort: auto

default_model: route/coding-latest
fallback_chain:
  - chatgpt/gpt-stable
```

`discovery` 字段：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | driver 默认值；ChatGPT Codex 为 `true` | 开关当前 provider 实例的发现 |
| `refresh_interval_ms` | 6 小时 | TTL；未到期的定时刷新不会访问网络 |
| `timeout_ms` | 30 秒 | 单次目录读取和验证流程的超时信号 |
| `client_version` | 当前 UTC 年月 | ChatGPT Codex `/models` 请求版本 |
| `allow` | 全部 | 大小写不敏感的 `*` / `?` glob 白名单 |
| `deny` | 空 | 优先级高于 `allow` 的 glob 黑名单 |

过滤配置变更会立即将被排除的动态模型标为 `deprecated`。provider 暂时未返回的模型会先进入
`stale`，保留 24 小时的 last-known-good 宽限期，随后进入 `deprecated`。

## 逻辑 route、物理模型和 pool

- `provider/model` 是精确物理模型，适合固定 session、回放和排障。
- `pool/<model_id>` 是跨订阅的规范逻辑模型标识，例如 `pool/gpt-5.6-sol`。
- `route/<name>` 在新 session 或显式切换时按能力和偏好选择物理模型。
- pool 的 context、output 和 capability 元数据取成员安全交集。
- reasoning 档位是请求策略。`supported_reasoning_efforts` 会将不支持的请求档位收敛到最近可用值，无需为每个档位复制模型。

Registry 会把当前 Catalog 中状态为 `verified` 或宽限期内 `stale`、且 `model_id` 相同的
provider 实例自动合成为 `pool/<model_id>`。即使当前只有一个可用订阅，也会生成这个逻辑 pool；
第二个订阅完成 OAuth 和发现后会在 Registry 重建时自动加入。成员使用
`sticky_quota_aware_failover`，优先级按 `providers` 的配置顺序确定，同一 session 会保持在已选订阅，
直到 quota、认证或临时可用性错误触发 failover。

自动 pool 只存在于运行时，不会写入 `config.yaml`。手工配置同名 `pool/<model_id>` 时，手工成员和
策略完整覆盖自动结果。旧配置中由多个相同 `model_id` 成员组成、但名称形如
`chatgpt/gpt-5.5` 的 pool 会在运行时映射为 `pool/gpt-5.5`；旧名称仍可解析，配置文件不会被静默改写。

route 支持 `models`、`providers`、`family`、`lanes`、`requires`、`tags`、`min_context`、
`min_output`、`prefer` 和 `reasoning_effort`。`prefer` 可取 `priority`、`newest`、`quality`、
`balanced`、`fast`。

route 解析后，session 持久化的是 `provider/model`；pool 解析后持久化的是规范
`pool/<model_id>`。Catalog 热更新不会改动正在运行的 turn；新 session 或重新初始化的 agent 会使用
最新 pool 成员。

## 刷新触发

Catalog 协调器统一处理以下触发：

1. 启动时先同步读取缓存，再在后台刷新，不阻塞系统 ready。
2. OAuth 登录完成、账号变化或关联 secret 更新后，强制刷新对应 provider。
3. 每分钟检查 TTL，仅对到期 provider 请求目录。
4. 模型返回 `model_not_found` 或 `unsupported_model` 后，将该模型临时下线并定向刷新。
5. 配置 reload 后按新 transport、过滤器和账号重新发现。
6. 配置页的 `Refresh models`，或手动 API 调用。

同一 provider、账号、transport 和配置版本的并发刷新会合并为一个请求。账号或 transport 在刷新
途中发生变化时，新旧刷新相互隔离，旧结果不会写入当前 Registry。

## 状态、缓存和失败语义

状态依次用于表达 `discovered`、`verifying`、`verified`、`unavailable`、`stale`、
`deprecated`。Registry 只激活 `verified`，以及仍在 24 小时宽限期内的 `stale` 条目。

缓存位置：

```text
.zero/cache/model-catalog/catalog.json
```

写入使用同目录临时文件加原子 rename，文件权限为 `0600`。缓存只保存规范化模型元数据、不可逆
账号指纹和探测状态；不会保存 access token、refresh token、请求正文或 provider 原始响应。

发现失败、验证服务异常、空目录或缓存损坏都不会清空 last-known-good 模型。单个模型明确返回
400/404 时会标为 `unavailable`。手工模型始终保留，因此可以用稳定型号维持 fallback。

## API 和运维

```text
GET  /api/providers/models/catalog
POST /api/providers/:provider/models/refresh
GET  /api/models
```

Catalog API 返回当前账号 scope 内的状态和规范化能力，不返回账号指纹或凭据。`/api/models` 同时
返回物理模型、自动 pool 和逻辑 route。`GET /api/config` 的 `runtimeModelPools` 是只读运行时视图，
不会被配置页保存回 `model_pools`。配置页 Models 标签展示来源、状态、lane、reasoning levels、
自动 pool 成员，并提供手动刷新。

日志只记录 verified、unavailable 和 error 数量。排障时优先查看 Catalog 状态、provider health、
transport 和账号是否匹配，再检查 route 的 capability/context 过滤条件。

## 迁移建议

1. 保留当前手工模型和 fallback chain，为每个订阅 provider 开启 discovery。
2. 观察 Catalog 中模型达到 `verified`，确认出现对应的 `pool/<model_id>`。
3. 把 `default_model`、scheduler、task closure 或 context compaction 逐步切到规范 pool；需要按能力选代际时再使用 route。
4. 对要求完全可复现的任务继续使用精确 `provider/model` pin。
5. 只为需要自定义成员顺序或 failover 策略的模型保留手工 `model_pools` override。
