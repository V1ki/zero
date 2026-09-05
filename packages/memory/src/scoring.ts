import type { Memory } from '@zero-os/shared'

/**
 * 检索打分 v2 的纯函数部分:词面(lexical)重叠通道与向量分仿射校准。
 * 词面通道按"候选池 IDF 加权的查询覆盖度"打分——稀有 token(如 yt-dlp、fxtwitter)
 * 命中比常见 token(如 视频、下载)权重高,天然免停用词表;title/tags 命中算满额,
 * 仅 content 命中打 6 折。
 */

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
const LATIN_TOKEN = /[a-z0-9]+(?:[._-]+[a-z0-9]+)*/g
const TOKEN_SPLIT = /[._-]+/

/**
 * 提取词面 token:CJK 连续段切成二元组(中文无空格分词的最低成本近似),
 * 拉丁/数字段保留原词并额外追加点号/连字符拆分的子词(api.fxtwitter.com → fxtwitter)。
 * 结果去重。
 */
export function tokenizeForLexical(text: string): string[] {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()

  for (const run of lower.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.add(run.slice(i, i + 2))
    }
  }

  for (const token of lower.match(LATIN_TOKEN) ?? []) {
    if (token.length >= 2) tokens.add(token)
    for (const part of token.split(TOKEN_SPLIT)) {
      if (part.length >= 2) tokens.add(part)
    }
  }

  return [...tokens]
}

export interface LexicalFieldTokens {
  /** 强字段:title ∪ tags ∪ type,命中记满额权重。 */
  strong: Set<string>
  /** 正文字段,命中记 0.6 折扣权重。 */
  content: Set<string>
}

export function buildMemoryFieldTokens(
  memory: Pick<Memory, 'title' | 'tags' | 'content' | 'type'>,
): LexicalFieldTokens {
  return {
    strong: new Set([
      ...tokenizeForLexical(memory.title),
      ...tokenizeForLexical(memory.tags.join(' ')),
      ...tokenizeForLexical(memory.type),
    ]),
    content: new Set(tokenizeForLexical(memory.content)),
  }
}

/**
 * 逐候选计算词面重叠分(0..1):Σ idf(t)·tier(t) / Σ idf(t)。
 * idf 在候选池内统计(df = 池中含该 token 的候选数),因此同一 token 在
 * 同域候选扎堆的池里权重自动衰减,在只被个别候选持有时刻意放大。
 */
export function computeLexicalScores(
  queryTokens: string[],
  candidates: LexicalFieldTokens[],
): number[] {
  if (queryTokens.length === 0 || candidates.length === 0) {
    return candidates.map(() => 0)
  }

  const idf = new Map<string, number>()
  let denominator = 0
  for (const token of queryTokens) {
    if (idf.has(token)) continue
    let df = 0
    for (const candidate of candidates) {
      if (candidate.strong.has(token) || candidate.content.has(token)) df += 1
    }
    const weight = Math.log(1 + candidates.length / (1 + df))
    idf.set(token, weight)
    denominator += weight
  }
  if (denominator <= 0) return candidates.map(() => 0)

  return candidates.map((candidate) => {
    let numerator = 0
    for (const token of queryTokens) {
      const weight = idf.get(token)
      if (weight === undefined) continue
      if (candidate.strong.has(token)) numerator += weight
      else if (candidate.content.has(token)) numerator += weight * 0.6
    }
    return Math.min(1, numerator / denominator)
  })
}

/**
 * 向量分仿射校准:原始 cosine 在 [floor, ceiling] 区间线性拉伸到 [0,1],区间外截断。
 * 同一记忆因查询措辞不同 cosine 可在 0.55~0.79 摆动(text-embedding-v4 实测),
 * 原始值不校准则 minScore 门槛随 embedding 模型漂移,无法跨模型设定。
 */
export function calibrateVectorScore(vector: number, floor: number, ceiling: number): number {
  if (ceiling <= floor) return vector >= ceiling ? 1 : 0
  const scaled = (vector - floor) / (ceiling - floor)
  return Math.min(1, Math.max(0, scaled))
}
