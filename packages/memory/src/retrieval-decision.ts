export interface RetrievalDecision {
  need: boolean
  queries?: string[]
}

/**
 * Build the prompt for the retrieval decision LLM call.
 * Combines "should we retrieve?" and "what queries?" into one call.
 *
 * @deprecated Replaced by the loop-driven memory retrieval agent in `retrieval-agent.ts`.
 */
export function buildRetrievalDecisionPrompt(userMessage: string, identitySummary: string): string {
  return `<instruction>
分析用户消息，判断是否需要从记忆库中检索历史信息来辅助回答。

需要检索的情况：
- 用户提到"之前"、"上次"、"那个问题"等指代历史事件
- 任务涉及已有的 runbook、incident、decision
- 需要了解项目上下文或技术决策背景
- 用户问题与身份记忆中提到但未展开的内容相关
- 任务涉及访问特定网站、平台或外部服务，可能存在已知的访问方式偏好
- 用户提供了 URL 链接，可能存在针对该域名的工具使用经验
- 操作需要使用浏览器、爬虫或特定 API 接入方式

不需要检索的情况：
- 通用技术问题（"如何写 TypeScript 泛型"）
- 当前身份记忆已包含足够信息
- 简单的操作指令（"帮我创建一个文件"）
- 闲聊或确认性回复

返回 JSON，不要其他内容：
需要检索: {"need": true, "queries": ["检索关键词1", "检索关键词2"]}
不需要:   {"need": false}

queries 是用于语义检索的关键词短语，每个 query 聚焦一个检索意图，最多 3 个。
</instruction>

<identity_summary>
${identitySummary || '（无身份记忆）'}
</identity_summary>

<user_message>
${userMessage}
</user_message>`
}

/**
 * Parse the LLM response into a RetrievalDecision.
 * Handles malformed responses gracefully (defaults to need=false).
 *
 * @deprecated Replaced by the loop-driven memory retrieval agent in `retrieval-agent.ts`.
 */
export function parseRetrievalDecision(response: string): RetrievalDecision {
  try {
    // Try to extract JSON from the response (may have surrounding text)
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { need: false }

    const parsed = JSON.parse(jsonMatch[0])
    if (typeof parsed.need !== 'boolean') return { need: false }

    if (parsed.need && Array.isArray(parsed.queries)) {
      return {
        need: true,
        queries: parsed.queries.filter((q: unknown) => typeof q === 'string').slice(0, 3),
      }
    }

    return { need: parsed.need }
  } catch {
    return { need: false }
  }
}
