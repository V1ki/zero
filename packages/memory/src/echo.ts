/**
 * S3 回声检测:turn 结束后判断注入记忆是否真的被模型"用"了——
 * 注入记忆中的特征词出现在本 turn 的助手输出(文本 + 工具调用入参)里。
 *
 * 特征词 = 出现在记忆里但【不出现在用户消息里】的 token:模型复述用户原话
 * 不需要任何记忆,排除掉这一最大混淆源。不做通用词频停用词表——
 * 中文取 CJK 二元组(天然比单词更具体),拉丁/数字 token 要求 ≥4 字符。
 * 这是高精度低召回信号:检到即记 used,检不到不作任何负判。
 */

/** 特征词命中数达到该阈值才判"被使用",避免一两个偶然碰撞误报 */
const DEFAULT_MIN_DISTINCT_HITS = 3

// 结构性/连接性高频词几乎不携带主题信号,出现在输出里说明不了"用了记忆",预排除。
const STOP_TOKENS = new Set([
  // CJK 高频二元组
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '一个',
  '一些',
  '可以',
  '需要',
  '进行',
  '问题',
  '如果',
  '但是',
  '然后',
  '已经',
  '还有',
  '什么',
  '没有',
  '使用',
  '通过',
  '关于',
  '以及',
  '或者',
  '因为',
  '所以',
  '时候',
  '现在',
  '直接',
  '同时',
  '这里',
  '情况',
  // 拉丁高频泛词(≥4 字符里仍然无主题信号的)
  'this',
  'that',
  'with',
  'from',
  'have',
  'will',
  'your',
  'their',
  'when',
  'what',
  'which',
  'user',
  'test',
  'true',
  'false',
])

export interface EchoMemoryInput {
  id: string
  /** 用于匹配的记忆文本(title + content 拼接即可) */
  text: string
}

export interface detectMemoryEchoOptions {
  /** 特征词最小命中数;默认 3 */
  minDistinctHits?: number
}

/** 抽取文本特征 token:CJK 二元组 + 长拉丁/数字词,剔除结构性高频词。 */
function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.toLowerCase()

  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]{3,}/g)) {
    if (!STOP_TOKENS.has(match[0])) tokens.add(match[0])
  }

  const cjkRuns = normalized.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i++) {
      const bigram = run.slice(i, i + 2)
      if (!STOP_TOKENS.has(bigram)) tokens.add(bigram)
    }
  }

  return tokens
}

/**
 * 对本 turn 注入的每条记忆做回声判定,返回判定为"被使用"的记忆 id 列表。
 * 纯同步计算、无 IO;调用方负责异步兜底,失败不影响 turn 主流程。
 */
export function detectMemoryEcho(
  memories: EchoMemoryInput[],
  turn: { userMessage: string; outputText: string },
  options?: detectMemoryEchoOptions,
): string[] {
  if (memories.length === 0) return []

  const userTokens = extractTokens(turn.userMessage)
  const outputTokens = extractTokens(turn.outputText)
  const minHits = options?.minDistinctHits ?? DEFAULT_MIN_DISTINCT_HITS
  const usedIds: string[] = []

  for (const memory of memories) {
    const memoryTokens = extractTokens(memory.text)
    let hits = 0
    for (const token of memoryTokens) {
      if (userTokens.has(token)) continue
      if (outputTokens.has(token)) hits++
      if (hits >= minHits) break
    }
    if (hits >= minHits) {
      usedIds.push(memory.id)
    }
  }

  return usedIds
}
