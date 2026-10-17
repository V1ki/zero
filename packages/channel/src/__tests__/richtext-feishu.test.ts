import { describe, expect, test } from 'bun:test'
import { renderMarkdownForFeishu } from '../richtext/feishu'

describe('renderMarkdownForFeishu', () => {
  test('converts Obsidian wikilink images in normal text', () => {
    expect(
      renderMarkdownForFeishu('封面：![[assets/cover.png]]', { preserveExternalImages: true }),
    ).toBe('封面：![cover](assets/cover.png)')
  })

  test('does not convert Obsidian wikilink images inside inline code', () => {
    expect(
      renderMarkdownForFeishu('请输出这个字面量：`![[assets/cover.png]]`', {
        preserveExternalImages: true,
      }),
    ).toBe('请输出这个字面量：`![[assets/cover.png]]`')
  })

  test('does not convert Obsidian wikilink images inside fenced code blocks', () => {
    expect(
      renderMarkdownForFeishu('```md\n![[assets/cover.png]]\n```', {
        preserveExternalImages: true,
      }),
    ).toBe('```md\n![[assets/cover.png]]\n```')
  })
})
