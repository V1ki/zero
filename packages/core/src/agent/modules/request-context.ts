import type { AgentLoopModule } from '../agent-loop'
import type { AgentContext } from '../agent-types'

/**
 * Request-only context in front of the turn's first user message: the dynamic context, and for a
 * model that cannot see images, where the user's images were saved. The base logs and applies both.
 */
export function requestContextModule(
  context: Pick<AgentContext, 'dynamicContext' | 'imageDelegationFiles'>,
): AgentLoopModule {
  return {
    requestInjections: () => [
      ...(context.dynamicContext
        ? [{ kind: 'dynamic' as const, content: context.dynamicContext }]
        : []),
      ...(context.imageDelegationFiles?.length
        ? [
            {
              kind: 'image_delegation' as const,
              content: buildImageDelegationPrompt(context.imageDelegationFiles),
            },
          ]
        : []),
    ],
  }
}

function buildImageDelegationPrompt(files: Array<{ path: string; mediaType: string }>): string {
  const fileLines = files.map(
    (file, index) => `- image ${index + 1}: ${file.path} (${file.mediaType})`,
  )
  return [
    '<image_delegation>',
    '当前模型不能直接看图。以下用户图片已保存为本地文件，可委托支持 vision 的子 agent 分析：',
    ...fileLines,
    '',
    '需要图片理解时，调用 spawn_agent，指定支持 vision 的模型，并设置 tools=["read_image"]。instruction 必须包含：这些图片的绝对路径、用户原始问题、判断标准、相关上下文，以及“只返回文字分析报告”。随后调用 wait_agent，基于子 agent 的文字报告回复用户。不要声称当前模型直接看到了图片。',
    '</image_delegation>',
  ].join('\n')
}
