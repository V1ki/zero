# 钉钉任务卡片模板

模板把任务摘要显示为普通文本，并为每个任务生成一个带编号的「我来跟进」按钮。一张周末摘要可以包含多个任务，点击其中一项只确认该项。摘要下方显示最近一次确认的任务编号。[下载模板](templates/dingtalk-task-card.json)

## 按编号继续任务

不配置 `card_template_id` 时，ZeRo 通过企业机器人的主动发信接口，把任务作为内置 Markdown 消息发给选定的单聊或群。界面会标为「内置 Markdown · 按任务编号回复」。在原私聊回复「#任务7 进展如何」，或在原群 @机器人并带上任务编号，即可继续讨论。需要机器人发信权限 `qyapi_robot_sendmsg`。第一次在新版 ZeRo 使用时，由指定操作人先发一条真实消息建立绑定。之后重启或临时回复地址过期，已保存的绑定仍可用于主动提醒。[钉钉机器人 SDK](https://github.com/alibabacloud-go/dingtalk/tree/master/robot_1_0)

## 从模板接入

1. 用有模板管理权限的帐号进入目标企业，在钉钉卡片平台选择或创建高级互动卡片模板。先在草稿中操作，保留正在使用的旧版本。[钉钉卡片平台](https://open-dev.dingtalk.com/fe/card)
2. 在编辑器右上角选「更多」→「导入」，导入上面的 JSON 文件。用内置的两个示例任务预览，确认两个按钮分别显示 101、102。在第一个按钮的属性里检查动作「回传请求」、动作 ID `ack` 和参数 `taskId`。参数值应绑定当前循环项的任务编号。[官方模板导入示例](https://github.com/open-dingtalk/dingtalk-card-examples)
3. 由模板管理者核对企业和应用可用范围，再发布测试版本并从详情页复制模板 ID。把 ID 填入 ZeRo 配置文件 `.zero/config.yaml` 中对应钉钉通道的 `card_template_id`。确认机器人已启用 Stream，应用有卡片实例写权限，然后重新加载通道配置。运行中应只有一个该应用的 Stream 客户端接收回调。[卡片创建和更新接口](https://github.com/open-dingtalk/dingtalk-card-examples#项目介绍)
4. 在明确选定的测试私聊或群中，让指定操作人向机器人发送一条消息，建立本通道的会话与操作人绑定。在网页的委托设置选定这组目标，触发一条可投递的事件。检查收件箱记录的回执、钉钉卡片上的任务编号以及点击后的同卡状态。合并两项任务时，再点击第二个按钮并核对对应任务。

## 字段约定

| 变量 | 搭建器类型 | 用途 |
| --- | --- | --- |
| `title` | 字符串 | 单项任务标题或合并摘要标题 |
| `summary` | 字符串 | 已筛选的摘要，保留换行 |
| `status` | 字符串 | 初始为「待跟进」，点击后由服务端更新 |
| `tasks` | 循环数组 | 每项带数字 `taskId` 和文本 `title`、`summary`。ZeRo 将数组编码为 JSON 字符串，放入 `cardData.cardParamMap.tasks` |

每个按钮都使用回传动作 `ack` 和当前行的 `taskId`。ZeRo 会核对平台回传的企业、会话、人员、卡片实例和该卡已投递的任务，再更新卡片状态。模板标题和摘要仅作为文本展示。

## 私聊绑定成功但主动发送返回 403

在 Router 打开该任务的提醒记录，核对钉钉错误码与请求编号。若为 `Forbidden.AccessDenied.IpNotInWhiteList`，请让应用管理员在开发者后台打开对应应用的「开发配置 → 安全设置 → 服务器出口 IP」，保留已有地址并追加钉钉实际看到的 ZeRo 出口 IP。生效后，在原任务中重试已明确失败的提醒，可沿用原会话和任务编号。[钉钉开发者后台](https://open-dev.dingtalk.com/#/) · [应用安全设置示例](https://help.aliyun.com/zh/sase/use-cases/use-sase-to-ensure-security-access-for-dingtaik-users)

## 验证边界

本模板已在本地检查导出包的 JSON、编辑器的组件与变量引用、渲染 XML 和按钮回传参数。钉钉的 `dws aicard lint` 用于 A2UI 消息，搭建器模板的导入、真实客户端排版与平台回调需在选定企业完成验收。模板文件不包含企业 ID、密钥或接收人。[官方循环交互示例](https://github.com/open-dingtalk/dingtalk-card-examples/tree/main/examples/循环渲染容器之交互组件的使用与服务端更新)
