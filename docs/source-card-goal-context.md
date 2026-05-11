# Source Card Goal 上下文

这份文档用于交给下一次 Codex `/goal` 运行读取。它整理了 session
`019e14f5-376a-73b3-84b4-da9cbeeaf58e` 中已经收敛的 Source Card 设计方向，
但不包含任何私人邮件正文、密钥、token、cookie、授权码、邮箱密码或其他敏感值。

## 一句话方向

Source Card 是 Zero 中关于“如何长期、稳定、安全、可审计地获取某类数据”的持久化契约。
它不是 cron，不是 watch，也不是一次性的工具调用记录。

## 已确定的边界

- Source Card 负责数据源身份、adapter 契约、凭证引用、隐私策略、健康检查、能力声明和
  adapter revision 历史。
- Watch 负责检查频次、query/cursor、触发条件和允许动作。Watch 只能引用
  `sourceCardId + capability`，不能保存或拥有凭证。
- Observation 负责高频运行时数据，比如股票报价快照、邮件 envelope metadata、健康检查结果、
  计数、hash、新鲜度和失败证据。
- Vault 或外部凭证存储负责真实密钥。Source Card 只能保存引用，例如 `vault://...`、
  `external:himalaya/account/qq` 或 `none`。
- Trace 可以记录脱敏证据：source card id、adapter revision、命令或 URL 模板 hash、状态码、
  exit code、耗时、行数、schema keys、artifact refs、failure class。Trace 不能记录密钥值或
  私人内容。

## Source Card 生命周期

- `discovered`：从 trace、用户请求、memory 或 artifact 中观察到；不能用于后台任务。
- `candidate`：已经有规范化 id、adapter mode、凭证引用、隐私策略和验证计划。
- `verified`：验证通过，并产生了脱敏证据。
- `active`：经过确认后提升为可用状态；Watch 可以消费声明为 watchable 的能力。
- `degraded`：部分失败、数据过期、schema drift、rate limit 或间歇性鉴权失败。
- `broken`：鉴权缺失或失败、adapter 不可用，或验证过程不安全。
- `retired`：被明确停用或替换；保留证据，但不能再被 Watch 使用。

## Adapter 类型

- `cli`：固定命令模板、可执行文件/version 检查、cwd、timeout、parser、允许的子命令，
  且不能在命令中内联展开密钥。
- `api`：endpoint 模板、HTTP method、headers、可选 credential ref、状态映射、schema keys
  和 rate limit。
- `browser`：只有在 API 或 direct protocol 不可用时使用；必须声明 profile/session 引用和
  脱敏规则。后台使用需要额外确认。
- `direct`：面向 IMAP、数据库、websocket、本地文件索引等协议的 typed client contract，
  包括 TLS/auth mode、cursor/pagination 和 schema。

## 示例：QQ 邮箱 Himalaya

预期 Source Card 形态：

- id: `qq-mail-himalaya`
- kind: 私人邮箱
- adapter mode: `cli`
- adapter entrypoint: himalaya CLI
- credential binding: `external:himalaya/account/qq`
- 默认隐私范围：只读取 envelope metadata
- 正文和附件访问：默认只能在前台任务中显式执行；除非某个 Watch 获得明确批准的 scope
- watch 兼容性：metadata-only 到达检查和通知
- 默认禁止：任意读取私人邮件正文、下载附件、发送邮件、把原始内容写进 trace

建议健康检查：

- CLI 可执行文件存在，并能返回支持的版本。
- himalaya account list 中存在目标 account alias。
- folder list 成功。
- 在被批准的 folder 上 envelope list 成功，并返回可解析 metadata。
- 账号缺失、鉴权 stderr、鉴权相关非零退出码，应把卡标记为 `broken`。

## 示例：A 股市场数据

预期 Source Card 形态：

- id: `a-stock-market-data`
- kind: 公共市场数据
- adapter mode: `api`
- credential binding: public endpoint 无需凭证
- data class: public market data
- watch 兼容性：只读刷新、提醒、记录 observation
- 默认禁止：券商登录、下单、调仓、自动交易

建议健康检查：

- canonical endpoints 返回 HTTP 200。
- 预期 JSON path 存在。
- 数据行数在合理范围内。
- 报价新鲜度符合交易日预期。
- rate limit、CAPTCHA、403、连续 5xx、timeout 或 schema drift 应根据严重程度标记为
  `degraded` 或 `broken`。

## 下一次 Goal 的实现期待

下一次 `/goal` 应该直接实现，不停留在计划。但它仍然应该选择符合当前代码风格的最小完整实现，
并保持测试和运行稳定。

实现要求：

- Source Card 必须与现有 `ScheduleConfig` 分离。
- Watch 或 schedule 不能拥有凭证。
- 先建立类型契约，再让运行时行为依赖它。
- 存储和 trace 输出必须默认脱敏。
- 修改行为或契约时必须补测试。
- 行为或运维预期变化时必须更新文档。
- 将整个修改过程记录到新的 Markdown 文件中，包括修改文件、设计决策、验证命令、结果和后续风险。

建议实现记录文件：

- `docs/source-card-implementation-log.md`

## 安全规则

- 绝不打印、粘贴、持久化或提交任何密钥值。
- 绝不直接编辑 `.zero/secrets.enc`。
- 不提交 `.zero/*`、运行时生成物、`dist`、`node_modules` 或测试输出。
- 实现过程中不要读取新的私人邮件正文。
- 不实现自动交易、自动发送邮件或远端写操作。
- 私人数据源行为有歧义时，默认只能 metadata-only，并要求显式批准更大范围。
