import type { MandatePlatform } from '@zero-os/shared'

const platforms: Record<string, MandatePlatform> = {
  微信: 'weixin',
  飞书: 'feishu',
  钉钉: 'dingtalk',
}

// Parse only a command at the start of the current user turn. Its body is literal
// user text and is displayed on the send card before it can reach a channel.
const commands = [
  /^(?:给我)?发(?:送)?(?:一?[条个次])?\s*(微信|钉钉|飞书)\s*(?:通知我|提醒我|(?:通知|提醒|消息)?(?:给我)?)/u,
  /^(?:用|通过|在)?\s*(微信|钉钉|飞书)(?:上)?\s*(?:(?:给我)?发(?:送)?(?:一?[条个次])?(?:通知|提醒|消息)|提醒我|通知我)/u,
  /^(?:给我)?发(?:送)?(?:一?[条个次])?(?:通知|提醒|消息)(?:到|至)\s*(微信|飞书|钉钉)/u,
]

export function parseDirectReminder(
  question: string,
): { platform: MandatePlatform; text: string } | null {
  const input = question.trim().replace(/^(?:(?:麻烦你?|请你?|帮我|现在|立即|马上)\s*)+/u, '')
  for (const command of commands) {
    const match = command.exec(input)
    if (!match) continue
    const rest = input.slice(match[0].length)
    const separated = /^[\s，,：:]/u.test(rest)
    if (
      !separated &&
      !/(?:提醒我|通知我)$/u.test(match[0]) &&
      !/^(?:提醒我|通知我|内容[是为])/u.test(rest)
    )
      return null
    const body = rest.trimStart().replace(/^[，,：:]\s*/u, '')
    // A request to change a schedule or to address somebody else is not a personal send.
    if (
      /^(?:(?:发)?给(?!我)|以后|每(?:次|天|周|月)|(?:等|当).+时(?:再)?(?:提醒|通知)|(?:明天|后天|今晚|\d+\s*(?:分钟|小时)后).*?(?:再发|提醒我|通知我))/u.test(
        body,
      )
    )
      return null
    const text = body
      .replace(
        /^(?:(?:请)?(?:通知我|提醒我|告诉我)|内容(?:是|为)|内容\s*[：:])\s*[，,：:]?\s*/u,
        '',
      )
      .trim()
    if (!text || /^(?:可以吗|行吗|怎么发|为什么|如何设置)[？?。]?$/u.test(text)) return null
    const quoted = /^(?:「([\s\S]+)」|“([\s\S]+)”|"([\s\S]+)")$/u.exec(text)
    const literal = quoted ? (quoted[1] ?? quoted[2] ?? quoted[3]).trim() : text
    return literal ? { platform: platforms[match[1]], text: literal } : null
  }
  return null
}
