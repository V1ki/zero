import { expect, test } from 'bun:test'
import {
  ROUTER_A2UI_CATALOG,
  ROUTER_A2UI_VERSION as version,
  type RouterSurfaceMessages,
} from '@zero-os/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { RouterSurface } from '../RouterSurface'

test('a generated card renders named evidence and emphasis while its submit button stays a single action', () => {
  const surfaceId = 'reading'
  const messages: RouterSurfaceMessages = [
    { version, createSurface: { surfaceId, catalogId: ROUTER_A2UI_CATALOG } },
    {
      version,
      updateComponents: {
        surfaceId,
        components: [
          { id: 'root', component: 'Column', children: ['source', 'submit'] },
          { id: 'source', component: 'Text', text: { path: '/evidence' } },
          {
            id: 'submit',
            component: 'Button',
            child: 'label',
            action: { event: { name: 'router_input' } },
          },
          { id: 'label', component: 'Text', text: '提交反馈' },
        ],
      },
    },
    {
      version,
      updateDataModel: {
        surfaceId,
        path: '/',
        value: { evidence: '**已合并**，见[原评论](https://example.com/issue#comment)' },
      },
    },
  ]
  const html = renderToStaticMarkup(<RouterSurface messages={messages} onAction={() => {}} />)
  expect(html).toContain('<strong>已合并</strong>')
  expect(html).toContain('href="https://example.com/issue#comment"')
  expect(html).toContain('<span>提交反馈</span></button>')
})
