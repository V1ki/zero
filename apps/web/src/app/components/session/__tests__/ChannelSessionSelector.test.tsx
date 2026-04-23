import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChannelSessionSelector } from '../ChannelSessionSelector'

describe('ChannelSessionSelector', () => {
  test('renders channel session metadata and options', () => {
    const html = renderToStaticMarkup(
      <ChannelSessionSelector
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
        onSelect={() => {}}
      />,
    )

    expect(html).toContain('Source')
    expect(html).toContain('Channel')
    expect(html).toContain('Channel ID')
    expect(html).toContain('oc_room_1')
    expect(html).toContain('feishu · oc_room_2 · current')
  })
})
