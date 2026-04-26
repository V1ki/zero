import type Anthropic from '@anthropic-ai/sdk'
import type { CompletionRequest } from '@zero-os/shared'
import { AnthropicAdapter } from './anthropic'

const DEEPSEEK_DEFAULT_EFFORT = 'high' as const

function normalizeEffort(
  effort: CompletionRequest['reasoningEffort'],
): NonNullable<Anthropic.OutputConfig['effort']> {
  if (effort === 'xhigh') return 'max'
  return effort ?? DEEPSEEK_DEFAULT_EFFORT
}

export class AnthropicDeepSeekAdapter extends AnthropicAdapter {
  override readonly apiType = 'anthropic-deepseek'

  protected override shouldIncludeThinkingBlocksInContent(): boolean {
    return true
  }

  protected override shouldRequireThinkingForToolUse(): boolean {
    return true
  }

  protected override buildThinkingConfig(_req: CompletionRequest): Anthropic.ThinkingConfigParam {
    return { type: 'enabled' } as Anthropic.ThinkingConfigParam
  }

  protected override buildOutputConfig(req: CompletionRequest): Anthropic.OutputConfig {
    return { effort: normalizeEffort(req.reasoningEffort) }
  }
}
