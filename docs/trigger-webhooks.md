# 用事件推送监听仓库

ZeRo Web 的「配置 → 监听」支持为每个 GitHub 仓库选择主动推送或轮询。已有订阅默认继续轮询。选定主动推送后，ZeRo 等待该仓库的回调，匹配到的事件沿用收件箱、Agent 与 Router 的处理流程。外部 CI 也可以向同一仓库订阅报告工作流失败。

## GitHub 设置

1. 在 ZeRo 的 Secrets 中保存一份随机生成的共享密钥，例如引用名 `github_webhook_project`。每个仓库使用独立的密钥。
2. 在监听设置中选择仓库，将接收方式切为 webhook，填写密钥引用。可分别勾选「Issue 普通评论」和「PR 普通评论」，按需叠加状态变化、工作流失败或 PR 评论提及条件，然后保存。私有仓库的分支核验还需要可读取 Pull requests 的 GitHub 凭证。
3. 在仓库的 **Settings → Webhooks** 添加 webhook。Payload URL 指向 `https://<你的入口>/webhook/github/OWNER/REPO`，Content type 选 `application/json`，Secret 填入与 ZeRo 相同的密钥值。要收 Issue 或 PR 普通讨论中的新评论，在 GitHub 勾选 **Issue comments**，再由 ZeRo 按这两项配置区分。该事件也用于 PR 的指定 @ 提及。跟踪状态变化时，按范围加选 **Issues**、**Pull requests**。收工作流失败时再选 **Workflow runs**。已有 webhook 也需检查订阅事件。保持 SSL 校验开启。
4. 在 **Recent deliveries** 查看 ping 的 HTTP 200。下一次仓库出现已勾选的变化时，按事件类型和对象编号核对 ZeRo 收件箱。若要验证评论，在所选 Issue 或 PR 的主讨论区发表一条普通新留言，在收件箱通过 GitHub 原文链接核对。网页和各 IM 入口共用 Router 的跟踪配置，可在网页的「GitHub 跟踪动态」查看 Router 已跟踪事件的处理结果。

可以在仓库卡片上单独「检查读取权限」。按钮按所选状态、普通评论、提及或 Actions 条件探测只读 API。公开仓库可匿名检查，私有仓库使用 GitHub 监听凭证。结果说明这些 API 是否可读。公网回调是否连通可在上述 ping 回执中确认。

GitHub 需要能通过 HTTPS 访问上述路径。如果 ZeRo 运行在本机，入口网关只转发已选择的 webhook 路径，配置页及其他 API 保持本地访问。保存 ZeRo 设置后仍需在仓库注册 webhook；GitHub 会发送 ping 检查连通性。[GitHub 创建 webhook](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)

每个 POST 都使用原始请求字节校验 `X-Hub-Signature-256`，并检查仓库、动作与监听条件。Issue 状态变化接收新建、重新打开和关闭。PR 另识别已合并的关闭事件，将其记为一次合并。Actions 只采集已完成且结论为 failure 的运行。PR 评论提及的分支条件按目标分支核验。对于同一运行的同一次尝试，轮询和 webhook 得到相同的事件编号。同一条评论按仓库和评论编号去重。[GitHub 签名校验](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) · [GitHub 事件定义](https://docs.github.com/en/webhooks/webhook-events-and-payloads)

仓库启用普通评论后，ZeRo 只收各项启用后新发表的 Issue 留言或 PR Conversation 留言，无需 @。编辑、删除、正式 Review 和逐行评审评论不会产生普通评论事件。轮询和 webhook 共用危险操作过滤规则，识别到索取密钥、要求执行破坏性命令等危险内容时会跳过整条评论，含 @ 提及也一样。

## 外部 CI 设置

在同一仓库启用“工作流失败”并配置单独的 CI 密钥引用，例如 `ci_webhook_project`。外部 CI 可以与 GitHub 轮询或 GitHub webhook 同时使用。CI 成功任务无需推送。失败任务向 `/webhook/ci/OWNER/REPO` 提交以下格式的 JSON，请在实际请求中使用本次失败的时间。

```json
{
  "version": 1,
  "kind": "workflow_failure",
  "eventId": "jenkins:project:184:1",
  "repository": "OWNER/REPO",
  "workflow": "Build",
  "branch": "main",
  "occurredAt": "2030-01-07T12:00:00Z",
  "summary": "集成测试失败"
}
```

`eventId` 由 CI 分配，可使用字母、数字和 `._:/-`，最长 192 个字符，以字母或数字开头。同一次失败重试投递时沿用原编号。多个 CI 共用一个订阅时，将 CI 名称、任务编号和运行次数编入编号。`occurredAt` 必须包含时区，`summary` 可省略。仓库、分支及工作流都按已保存的订阅核验。

下面的示例从 CI 的密钥环境变量获取共享密钥，将生成的同一份字节用于签名和请求体。环境变量 `ZERO_CI_WEBHOOK_URL` 保存完整回调地址，`ZERO_CI_WEBHOOK_SECRET` 保存 CI 专用密钥，`event.json` 保存本次事件。

```python
import hashlib
import hmac
import os
from pathlib import Path
from urllib.request import Request, urlopen

body = Path("event.json").read_bytes()
secret = os.environ["ZERO_CI_WEBHOOK_SECRET"].encode()
signature = hmac.new(secret, body, hashlib.sha256).hexdigest()
request = Request(os.environ["ZERO_CI_WEBHOOK_URL"], data=body, method="POST", headers={
    "Content-Type": "application/json",
    "X-Zero-Signature-256": f"sha256={signature}",
})
with urlopen(request, timeout=15) as response:
    print(response.status, response.read().decode())
```

## 投递回执

| HTTP 状态 | 含义 |
| --- | --- |
| 200 accepted | 数据库已接收匹配的事件，或已存在同一事件。重复投递只保留一条记录。 |
| 200 ignored | 有效的回调与监听条件不符，或事件发生在订阅读取起点之前。GitHub ping 也返回此状态。 |
| 400 / 401 | 请求格式、来源仓库或签名不正确。修正配置或请求体后重新发送。 |
| 404 | 指定仓库尚未启用对应接收方式。 |
| 413 / 415 | 请求体超过 1 MiB，或内容类型不是 JSON。 |
| 503 | 密钥暂不可用、上游分支查询或本地处理失败，或处理过程中订阅发生变化。排查后用同一事件重新投递。 |

持久化成功后才返回 accepted。微信、钉钉、飞书或 Web 的后续投递结果在 Router 中查看。外部 CI 可对临时失败做有上限的退避重试。GitHub 的失败回调可以在 Recent deliveries 手动重投。[GitHub 重投说明](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)

多个配置客户端共用本机服务时，可以在 `PUT /api/listeners/config` 的请求体中附带整数 `expectedMandateRevision`。先从 `GET /api/listeners/mandates/config` 读取委托版本并核对受影响的委托，再连同来源自身的 `revision` 一起提交。服务端在同一数据库事务中核验两个版本，任一版本过期均返回 HTTP 409。省略此字段时仍只核验来源版本。


### Router Worker 的公开资料核查

Worker 可使用 `read_public_source` 自主核对公开文档、发布记录与其他一手资料。该能力只执行无凭据的 HTTPS GET，校验 DNS 与每次重定向并固定连接地址，拒绝内网、认证地址和非默认端口。正文保留来源、读取时间与续读位置；JSON 可按 Pointer 选择字段，避免大份元数据耗尽上下文。它不赋予外部写入、Bash 或本地文件访问权，也不根据仓库或关键字选择调查路径。

Router 应对照用户原始目标检查 Worker 的证据；能查证的缺口继续原 Worker，真正缺少环境数据或权限时才记录等待与恢复条件。阅读验收检验交付是否清楚，不替代实际任务的完成标准。

在 Router 网页发送文字后，服务器先保存消息并返回当前对话。处理上一条消息期间，用户可以继续补充。网页显示排队状态，Router 依次读取前一轮答复并处理后续消息。刷新页面可以查看原记录。重启时，已保存且尚未开始的消息会继续执行，执行中断的轮次则保留结果或错误，供用户核对后重试。网页客户端在消息请求中使用 `background: true` 取得受理快照，状态码为 202。

经过验证的机器人私聊也会保存排队中的文字。服务重启并连接渠道后，Router 会核对消息接收时的配置和私聊绑定，再通过原机器人继续回复。恢复投递的结果保存在操作记录中。用户已经换绑或撤权时，原消息会记下无法继续的原因。

Router 和通用 Worker 不设置预设的单轮时长、模型调用次数、工具调用次数、累计 Token 或估算费用上限；Worker 队列也不再设置 10 分钟执行超时。不会因接近这些旧阈值而撤掉工具、压缩回答或强制交还结果。用量与估算费用仅进入执行轨迹，不参与终止判断；模型单次响应容量、服务方限流或真实请求失败仍按实际回执记录。

用户取消、暂停、授权失效及服务停止仍能中断执行。中断保留已有工具结果位置，续办可先读原 Worker 的证据索引，再读取具体结果，避免重复调查；中断和单轮返回都不代表事项完成。

### AI 卡片正文与认证读取

钉钉 AI 模板的 Markdown 正文需要通过流式更新接口写入，即使回复已经完整生成，也要提交一次全量终帧。使用 `docs/templates/dingtalk-router-ai-card.json` 时，在钉钉渠道配置中设置 `card_streaming_key: summary`；普通互动卡片不设置此项，沿用原有投递方式。创建卡片与正文更新都收到成功回执后才记为受理；正文更新失败时保留原卡，标记待核对，不能自动重建重复卡片。结果卡片不显示“回复已生成”等内部流程状态。平台受理不代表客户端显示正确，仍需实际阅读验收。

仓库 Worker 的 `read_repository` 使用当前已授权的 GitHub 连接，覆盖 Issue、PR、评论、补丁、审核、检查和固定提交的源码读取，不要求任务必须来自 GitHub 事件。公开资料工具不携带凭据，不能代替认证仓库读取。宿主机安装并登录 `gh` 不意味着每种 Worker 自动拥有命令行或账号访问能力；工程执行器必须单独核验实际工具与权限。

结果卡片使用 `publish_update`，其 `text` 由 Agent 按平台组织；钉钉 Markdown 使用空行、列表和带标题的链接，不依赖单换行形成段落。用户只要求某个平台时，Agent 可通过可选的 `deliveryChannels` 指定目标，`presentations` 必须恰好覆盖这些已配置平台；省略该参数仍按初期要求覆盖全部已配置平台。此工具生成新交付，不声称原地更新旧卡。`send_personal_reminder` 只用于纯文字提醒，不能用它验收原生卡片排版。

同一事项的自动跟进不设每小时派工次数配额。已移除旧的 8 次自动派工、32 次总派工拦截；已有数据库中的历史计数不再参与执行判断。Router 根据目标、进展及真实能力继续原 Worker，用户明确暂停、取消或事项完成仍会阻止继续派工。单轮次数、用量、费用和时长限制也已移除，不新增替代配额。


### 工程能力与完整结果

Router 工程 Worker 使用本机 Codex 在任务工作区生效的配置；启动和恢复均读取当前权限策略，不另建禁网、禁插件、禁 MCP、禁技能或只读 `.git` 的 Router 专用配置。工作区仍由已授权仓库映射确定，并核对 Codex 返回的目录；任务取消继续传递到原线程。现有 Codex 配置决定可用权限，不因这个调整赋予某项具体远端写操作新的业务授权。

Router 和 ZeRo Worker 不再设置专用的 2048 或 8192 Token 输出容量，使用所选模型配置的 `maxOutput`；未提供时使用提供商默认行为。若提供商返回 `max_tokens`，保存真实响应并继续生成，拼接完整正文。截断响应中的工具调用不会执行，下一次请求会要求重新提供完整参数；用户取消仍终止续写，部分结果不会作为完成结果交付。

Codex 交回文本、Worker 入库结果和待确认问题完整保存，不再按 8000、12000 或 500 字符静默截断。界面摘要与分页不得覆盖完整结果；历史已经截断的记录不会因此自动恢复，需通过原 Worker 的证据轨迹或原 Codex 线程取得。


工程 Worker 支持在 Codex 明确返回 `usageLimitExceeded` 时切换已配置的备用账号，并恢复同一个 Codex 线程。配置见 `docs/zero-cli.md` 的账号回退说明。模型资格、普通限流和额度耗尽分别处理，不用换账号掩盖其他错误。

### Worker 上下文交接与中断恢复

Router 派给 ZeRo 或 Codex 的任务均携带当前事项上下文（目标、完成条件、状态、证据与授权来源）及同一任务、同一入口范围内的完整历史步骤。Codex 续办同时恢复其原线程；历史资料不会被当作新增授权。上下文在派工边界脱敏，长结果不截断。

Codex 创建或恢复线程后，在提交执行轮次前把线程编号写入当前任务。执行失败、连接中断或服务重启不会丢失已记录的线程；Router 核对结果后可以继续原线程。无法确定的外部操作仍记录为结果未知，不把保留线程误报为执行成功。此机制不回填历史版本已经丢失的线程编号。

在「Router → 跟进事项」中，选择 Worker 的工作轨迹可以查看该次派工，并返回同一事项。ZeRo 模型调用记录实际发送给模型的请求。Codex 轨迹分别记录宿主提交给 Codex 的请求、原生线程和轮次、公开命令结果、文件变更及最终答复。可以查看和导出这些记录。Codex 内部模型请求由 Codex 管理。历史任务是否有执行轨迹，以当时实际保存的记录为准。

原执行器缺少所需能力时，Router 可以在同一事项派工，并用 `handoffFromJobId` 指定移交来源。新 Worker 的输入包含原 Worker 在移交时的状态、启动新执行器时观察到的状态、此前各轮的完整结论，以及移交前已记录的公开证据。宿主会核对事项归属和来源授权；原工作记录保留在原线程。

在 Router 轨迹页可打开一次重放，查看原运行和重放输入的对照。每个重放工具调用都记录它复用的原运行和回执编号。缺少匹配的历史回执时，轨迹显示未匹配；调试工具不会转到实际业务执行器。并发重放各自返回本次运行编号。
