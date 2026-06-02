import { describe, expect, test } from 'bun:test'
import {
  type ChannelSessionCandidate,
  resolveChannelSessionCandidate,
} from './session-detail-helpers'

const candidates: ChannelSessionCandidate[] = [
  {
    id: 'sess_tg_2',
    source: 'telegram',
    channelName: 'telegram:ops',
    channelId: 'room_2',
    isCurrent: true,
    placement: 'current',
    updatedAt: '2026-03-08T00:00:03.000Z',
  },
  {
    id: 'sess_tg_1',
    source: 'telegram',
    channelName: 'telegram:hr',
    channelId: 'room_1',
    isCurrent: true,
    placement: 'current',
    updatedAt: '2026-03-08T00:00:02.000Z',
  },
]

describe('resolveChannelSessionCandidate', () => {
  test('prefers matching channel id when present', () => {
    expect(resolveChannelSessionCandidate(candidates, 'room_1')?.id).toBe('sess_tg_1')
  })

  test('prefers matching channel name when both channel name and id are present', () => {
    const duplicated = [
      candidates[0],
      { ...candidates[0], id: 'sess_tg_3', channelName: 'telegram:finance' },
    ]

    expect(resolveChannelSessionCandidate(duplicated, 'room_2', 'telegram:finance')?.id).toBe(
      'sess_tg_3',
    )
  })

  test('falls back to first candidate when channel id is missing', () => {
    expect(resolveChannelSessionCandidate(candidates)?.id).toBe('sess_tg_2')
  })

  test('does not fall back across sources when preferred source is missing', () => {
    expect(resolveChannelSessionCandidate(candidates, undefined, undefined, 'feishu')).toBeNull()
  })

  test('returns null when channel id does not match', () => {
    expect(resolveChannelSessionCandidate(candidates, 'room_404')).toBeNull()
  })

  test('prefers the unnamed channel variant when channelName is absent', () => {
    const duplicated = [
      {
        id: 'sess_fei_1',
        source: 'feishu',
        channelId: 'room_shared',
        isCurrent: true,
        placement: 'current',
        updatedAt: '2026-03-08T00:00:03.000Z',
      },
      {
        id: 'sess_fei_2',
        source: 'feishu',
        channelName: 'web-auto',
        channelId: 'room_shared',
        isCurrent: true,
        placement: 'current',
        updatedAt: '2026-03-08T00:00:04.000Z',
      },
    ] satisfies ChannelSessionCandidate[]

    expect(resolveChannelSessionCandidate(duplicated, 'room_shared')?.id).toBe('sess_fei_1')
  })

  test('respects the preferred source when multiple sources share a channel id', () => {
    const duplicated = [
      {
        id: 'sess_web_1',
        source: 'web',
        channelName: 'web',
        channelId: 'room_shared',
        isCurrent: true,
        placement: 'current',
        updatedAt: '2026-03-08T00:00:03.000Z',
      },
      {
        id: 'sess_tg_1',
        source: 'telegram',
        channelName: 'telegram',
        channelId: 'room_shared',
        isCurrent: true,
        placement: 'current',
        updatedAt: '2026-03-08T00:00:04.000Z',
      },
    ] satisfies ChannelSessionCandidate[]

    expect(
      resolveChannelSessionCandidate(duplicated, 'room_shared', 'telegram', 'telegram')?.id,
    ).toBe('sess_tg_1')
  })
})
