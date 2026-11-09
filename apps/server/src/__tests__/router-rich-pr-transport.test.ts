import { expect, mock, test } from 'bun:test'
import type { DingtalkChannel, FeishuChannel, WeixinChannel } from '@zero-os/channel'
import type { ChannelAdapter } from '../channels/adapter'
import { DingtalkAdapter } from '../channels/dingtalk'
import { FeishuAdapter } from '../channels/feishu'
import { WeixinAdapter } from '../channels/weixin'
import { dispatchRouterCommand } from '../runtime/channel-runtime/runtime-common'
import type { TriggerTaskBridge } from '../triggers/task-bridge'

const reply =
  '只有 **[#145](https://github.com/example/project/pull/145)** 是文档改动。\n\n签收候选已验证，原分支尚未更新。'
test.each(['feishu', 'dingtalk', 'weixin'] as const)(
  '%s dispatch preserves the filtered answer and guards the original private reply',
  async (platform) => {
    const send = mock(async (..._args: unknown[]) => {})
    let adapter: ChannelAdapter
    if (platform === 'dingtalk')
      adapter = new DingtalkAdapter({ reply: send } as unknown as DingtalkChannel)
    else if (platform === 'feishu')
      adapter = new FeishuAdapter({ router: { replyMarkdown: send } } as unknown as FeishuChannel)
    else adapter = new WeixinAdapter({ replyPlainText: send } as unknown as WeixinChannel)
    const incoming = {
      channelType: platform,
      senderId: 'owner',
      timestamp: new Date().toISOString(),
      content: '只看文档 PR',
      metadata: {
        chatType: platform === 'weixin' ? 'dm' : 'p2p',
        conversationType: '1',
        routerDirect: true,
        chatId: 'peer',
        messageId: 'msg',
      },
    }
    let allowed = true
    const mayReply = () => allowed
    const bridge: TriggerTaskBridge = {
      publication: async () => false,
      isSelectedBot: () => true,
      handle: async () => ({ handled: true, reply, mayReply }),
      card: async () => false,
      close: async () => {},
    }
    const channel = { channelName: 'bot', channelType: platform, channelAdapter: adapter }
    await dispatchRouterCommand(incoming, channel, bridge)
    expect(send).toHaveBeenCalledTimes(1)
    const expected =
      platform === 'feishu' ? ['msg', reply, mayReply] : ['peer', reply, 'msg', mayReply]
    expect(send.mock.calls[0]).toEqual(expected)
    allowed = false
    await dispatchRouterCommand(incoming, channel, bridge)
    expect(send).toHaveBeenCalledTimes(1)
    allowed = true
    send.mockRejectedValueOnce(new Error('receipt lost'))
    await expect(dispatchRouterCommand(incoming, channel, bridge)).rejects.toThrow('receipt lost')
    expect(send).toHaveBeenCalledTimes(2)
  },
)
