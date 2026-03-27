import { describe, expect, test } from 'bun:test'
import { shouldRenderAssistantAsPlainText } from '../ChatDrawer'

describe('ChatDrawer assistant rendering', () => {
  test('preserves multiline plain-text command output', () => {
    expect(
      shouldRenderAssistantAsPlainText(
        'Session Info\n-------------------------\nID: sess_123\nModel: openai-codex/gpt-5.4-medium',
      ),
    ).toBe(true)
  })

  test('keeps markdown replies on the markdown renderer path', () => {
    expect(
      shouldRenderAssistantAsPlainText('## Summary\n- item one\n- item two'),
    ).toBe(false)
    expect(
      shouldRenderAssistantAsPlainText('Use `bun run check` and then review the output.'),
    ).toBe(false)
  })
})
