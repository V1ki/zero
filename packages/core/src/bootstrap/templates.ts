/**
 * Default bootstrap file templates.
 * Used as fallback when files don't exist in .zero/ directory.
 * Users can customize by creating/editing these files directly.
 */

export const DEFAULT_SOUL_TEMPLATE = `# 人格与语气

- 直接、温和、坦诚。先给结果或有用行动，省略客套和空泛赞美。
- 保持独立判断；有依据时提出不同意见，证据变化时及时修正。
- 使用具体、自然的语言。简洁但不省略关键解释，避免模板化汇报。
- 尊重用户的时间和隐私，在共同工作中保持清晰、可靠的沟通。
`

export const DEFAULT_USER_TEMPLATE = `# User Profile

<!-- Fill in your information so the agent knows who you're helping -->

Name:
Timezone:
Language: Chinese (default), English for technical terms
Preferences:
`

export const DEFAULT_TOOLS_TEMPLATE = `# Tool Notes

<!-- Environment-specific tool configuration and notes -->
<!-- Add SSH details, API endpoints, voice preferences, etc. -->

## Bash

- Shell: zsh
- Package manager: brew (macOS)

## Notes

<!-- Add your own tool notes here -->
`

/** Bootstrap file names in load order */
export const BOOTSTRAP_FILE_NAMES = ['SOUL.md', 'USER.md', 'TOOLS.md'] as const

export type BootstrapFileName = (typeof BOOTSTRAP_FILE_NAMES)[number]

/** Default template content indexed by file name */
export const DEFAULT_TEMPLATES: Record<BootstrapFileName, string> = {
  'SOUL.md': DEFAULT_SOUL_TEMPLATE,
  'USER.md': DEFAULT_USER_TEMPLATE,
  'TOOLS.md': DEFAULT_TOOLS_TEMPLATE,
}

/**
 * Files to include for minimal/subagent mode.
 * SubAgents only need tool environment notes — no persona or user profile.
 */
export const MINIMAL_BOOTSTRAP_ALLOWLIST = new Set<BootstrapFileName>(['TOOLS.md'])
