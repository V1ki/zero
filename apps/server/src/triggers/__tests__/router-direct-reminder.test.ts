import { expect, test } from 'bun:test'
import { parseDirectReminder } from '../router-direct-reminder'

test('prepares an immediate personal notification using only the current explicit request and literal body', () => {
  expect(parseDirectReminder('发送微信通知, 通知我处理 DeepSeek 的充值')).toEqual({
    platform: 'weixin',
    text: '处理 DeepSeek 的充值',
  })
  expect(parseDirectReminder('请用飞书提醒我整理研究文档')).toEqual({
    platform: 'feishu',
    text: '整理研究文档',
  })
  expect(parseDirectReminder('给我发条钉钉消息：「核对发布\n随后检查回执」')).toEqual({
    platform: 'dingtalk',
    text: '核对发布\n随后检查回执',
  })
  expect(parseDirectReminder('发送消息到微信：提醒事项 A')).toEqual({
    platform: 'weixin',
    text: '提醒事项 A',
  })
  expect(parseDirectReminder('发微信提醒我处理充值')).toEqual({
    platform: 'weixin',
    text: '处理充值',
  })
})

test('does not turn explanations, future rules, ambiguous recipients or empty commands into draft notifications', () => {
  for (const message of [
    '为什么不能发送微信通知？',
    '不要发送微信通知：处理充值',
    '例如：发送微信通知，处理充值',
    '如果 CI 失败就发送钉钉通知：构建失败',
    '每天用飞书提醒我写日报',
    '发送微信通知，明天下午再发',
    '发送微信通知给张三：检查构建',
    '发送微信和飞书通知：检查构建',
    '发送微信通知',
    '发送微信通知，提醒我',
    '发送微信通知，可以吗？',
  ])
    expect(parseDirectReminder(message)).toBeNull()
})
