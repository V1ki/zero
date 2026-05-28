import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChannelSessionSelector } from '../ChannelSessionSelector'

describe('ChannelSessionSelector', () => {
  test('renders channel session metadata and options', () => {
    const html = renderToStaticMarkup(
      <ChannelSessionSelector
        sources={['feishu', 'telegram']}
        candidates={[
          {
            id: 'sess_1',
            source: 'feishu',
            channelName: 'feishu',
            channelId: 'oc_room_1',
            isCurrent: true,
            placement: 'current',
            updatedAt: '2026-03-08T00:00:00.000Z',
          },
          {
            id: 'sess_2',
            source: 'feishu',
            channelName: 'feishu',
            channelId: 'oc_room_2',
            isCurrent: true,
            placement: 'current',
            updatedAt: '2026-03-08T00:10:00.000Z',
          },
        ]}
        selectedCandidate={{
          id: 'sess_1',
          source: 'feishu',
          channelName: 'feishu',
          channelId: 'oc_room_1',
          isCurrent: true,
          placement: 'current',
          updatedAt: '2026-03-08T00:00:00.000Z',
        }}
        activeSource="feishu"
        loading={false}
        sourceLoading={false}
        onSourceSelect={() => {}}
        onSelect={() => {}}
      />,
    )

    expect(html).toContain('Source')
    expect(html).toContain('Channel')
    expect(html).toContain('telegram')
    expect(html).toContain('feishu ·')
    expect(html).toContain('ago')
    expect(html).not.toContain('Channel ID')
    expect(html).not.toContain('oc_room_1')
    expect(html).not.toContain('oc_room_2')
  })
})
