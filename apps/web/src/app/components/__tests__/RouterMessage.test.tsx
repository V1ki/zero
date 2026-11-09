import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RouterMessage } from '../RouterMessage'

describe('Router result reading', () => {
  test('retains conditions, negation, numbers and named evidence in structured text', () => {
    const html = renderToStaticMarkup(
      <RouterMessage
        text={
          '找到相似问题，但**不能确认**原因。\n\n只有测试通过，才可继续。\n\n1. 已检查 3 项。\n2. 还有 2 项未核实。\n\n[查看原始记录](https://example.com/evidence)'
        }
      />,
    )
    expect(html).toContain('<strong>不能确认</strong>')
    expect(html).toContain('只有测试通过，才可继续。')
    expect(html).toContain('<ol>')
    expect(html).toContain('还有 2 项未核实。')
    expect(html).toContain('href="https://example.com/evidence"')
  })
  test('keeps the end of a long answer and makes wide comparisons scrollable', () => {
    const html = renderToStaticMarkup(
      <RouterMessage
        text={`${'已检查的内容。\n\n'.repeat(600)}最后一项仍未完成。\n\n| 方案 | 限制 |\n| --- | --- |\n| A | 尚未验证 |`}
      />,
    )
    expect(html).toContain('最后一项仍未完成。')
    expect(html).toContain('aria-label="表格，可横向滚动"')
    expect(html).toContain('<th>限制</th>')
    expect(html).toContain('<td>尚未验证</td>')
  })
  test('does not execute raw HTML, expose unsafe links or load external images', () => {
    const html = renderToStaticMarkup(
      <RouterMessage
        text={
          '<script>alert(1)</script>\n\n[执行](javascript:alert%281%29)\n\n![示意图](https://example.com/pixel.png)\n\n原始事实仍保留。'
        }
      />,
    )
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<img')
    expect(html).toContain('查看图片：示意图')
    expect(html).toContain('原始事实仍保留。')
  })
})
