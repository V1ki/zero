# 用事件推送监听仓库

ZeRo Web 的「配置 → 监听」支持为每个 GitHub 仓库选择主动推送或轮询。已有订阅默认继续轮询。选定主动推送后，ZeRo 等待该仓库的回调，匹配到的事件沿用收件箱、Agent 与 Router 的处理流程。外部 CI 也可以向同一仓库订阅报告工作流失败。

## GitHub 设置

1. 在 ZeRo 的 Secrets 中保存一份随机生成的共享密钥，例如引用名 `github_webhook_project`。每个仓库使用独立的密钥。
2. 在监听设置中选择仓库，将接收方式切为 webhook，填写密钥引用并保存。保留需要追踪的分支、工作流名称或文件路径，以及 PR 评论中提及的账号。私有仓库的分支核验还需要可读取 Pull requests 的 GitHub 凭证。
3. 在仓库的 **Settings → Webhooks** 添加 webhook。Payload URL 指向 `https://<你的入口>/webhook/github/OWNER/REPO`，Content type 选 `application/json`，Secret 填入与 ZeRo 相同的密钥值。按订阅范围勾选 **Workflow runs** 与 **Issue comments**。保持 SSL 校验开启。
4. 在 **Recent deliveries** 查看 ping 的 HTTP 200。运行失败的工作流，或在 PR 会话中添加一条提及已配置账号的普通评论，然后在 ZeRo 的收件箱查看。启用自动路由后，还可以在 Router 工作台看见分析与投递结果。

可以在仓库卡片上单独「检查读取权限」。按钮按当前选择的 Actions、PR 普通讨论和目标分支规则探测只读 API。公开仓库可匿名检查，私有仓库使用 GitHub 监听凭证。结果说明这些 API 是否可读。公网回调是否连通可在上述 ping 回执中确认。

GitHub 需要能通过 HTTPS 访问上述路径。如果 ZeRo 运行在本机，入口网关只转发已选择的 webhook 路径，配置页及其他 API 保持本地访问。保存 ZeRo 设置后仍需在仓库注册 webhook；GitHub 会发送 ping 检查连通性。[GitHub 创建 webhook](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)

每个 POST 都使用原始请求字节校验 `X-Hub-Signature-256`，并检查仓库、动作与监听条件。Actions 只采集已完成且结论为 failure 的运行，PR 的分支条件按目标分支核验。对于同一运行的同一次尝试，轮询和 webhook 得到相同的事件编号。PR 的普通评论按评论编号去重。[GitHub 签名校验](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) · [GitHub 事件定义](https://docs.github.com/en/webhooks/webhook-events-and-payloads)

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
