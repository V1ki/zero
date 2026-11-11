import { describe, expect, test } from 'bun:test'
import type { RouterSummary, RouterSummaryCounts } from '@zero-os/shared'
import { summaryCoverage, summaryGroups, summaryThresholds } from '../router-summary-text'

type Patch = { [K in keyof RouterSummaryCounts]?: Partial<RouterSummaryCounts[K]> }
function counts(patch: Patch = {}): RouterSummaryCounts {
  return {
    notifications: { personal: 0, mandate: 0, ...patch.notifications },
    triage: { filtered: 0, restored: 0, ...patch.triage },
    investigation: { notified: 0, unread: 0, unfinished: 0, expired: 0, ...patch.investigation },
    reports: {
      completed: 0,
      ready: 0,
      raw: 0,
      pending: 0,
      unrequested: 0,
      expired: 0,
      decisions: 0,
      answered: 0,
      recommended: 0,
      ...patch.reports,
    },
  }
}
function summary(now: Patch = {}, before: Patch = {}, extra: Partial<RouterSummary> = {}) {
  return {
    days: 7,
    current: {
      from: '2026-11-04T04:00:00.000Z',
      to: '2026-11-11T04:00:00.000Z',
      counts: counts(now),
    },
    previous: {
      from: '2026-10-28T04:00:00.000Z',
      to: '2026-11-04T04:00:00.000Z',
      counts: counts(before),
    },
    recordedSince: '2026-01-01T00:00:00.000Z',
    retentionDays: null,
    ...extra,
  } satisfies RouterSummary
}
const group = (s: RouterSummary, id: string) => {
  const found = summaryGroups(s).find((g) => g.id === id)
  if (!found) throw new Error(`missing ${id}`)
  return found
}
const allText = (s: RouterSummary) => JSON.stringify([summaryGroups(s), summaryCoverage(s)])

describe('Router summary sentences', () => {
  test('an empty window reads in words, never as 0 of 0 or NaN', () => {
    const s = summary()
    expect(summaryGroups(s).map((g) => g.sentence)).toEqual([
      '近 7 天没有发出通知，也没有事件被分诊过滤。之前的 7 天没有发出通知。',
      '近 7 天分诊没有过滤任何事件。之前的 7 天没有过滤事件。',
      '近 7 天没有来自「读取 GitHub 详情后提醒」委托的通知。之前的 7 天没有这类通知。',
      '近 7 天没有完成的派工。之前的 7 天没有完成的派工。',
    ])
    expect(summaryGroups(s).flatMap((g) => g.warnings)).toEqual([])
    expect(allText(s)).not.toMatch(/NaN|0 \/ 0|Infinity|undefined/)
  })

  test('a populated window leads with the answer and keeps the figures beside the previous ones', () => {
    const s = summary(
      {
        notifications: { personal: 3, mandate: 9 },
        triage: { filtered: 6, restored: 2 },
        investigation: { notified: 4, unread: 1, unfinished: 1 },
        reports: { completed: 9, ready: 6, raw: 1, decisions: 3, answered: 2, recommended: 1 },
      },
      {
        notifications: { personal: 10, mandate: 8 },
        triage: { filtered: 2, restored: 1 },
        investigation: { notified: 1, unread: 1 },
        reports: { completed: 2, ready: 1, raw: 1, decisions: 1 },
      },
    )
    expect(summaryGroups(s).map((g) => g.sentence)).toEqual([
      '近 7 天发出了 12 条通知，另有 6 条事件被分诊过滤，没有打扰你。之前的 7 天发出了 18 条。',
      '近 7 天分诊过滤了 8 条事件，你点「仍然通知」或「仍然提醒」找回了其中 2 条。之前的 7 天过滤了 3 条，找回 1 条。',
      '近 7 天有 4 条通知先读取了 GitHub 详情再发出，其中 1 条没能读到详情、1 条调查没有完成，只按事件摘要发出。之前的 7 天有 1 条，其中 1 条没能读到详情。',
      '近 7 天派工共完成 9 次执行，6 次整理成了汇报，1 次整理失败、只给你看了原始结果。汇报里提了 3 个需要你决定的问题，你回答了 2 个，其中 1 个选的是推荐项。之前的 7 天完成 2 次，提了 1 个问题。',
    ])
    expect(group(s, 'notifications').figures).toEqual([
      { label: '送到的事件提醒', value: 3, previous: 10 },
      { label: '送到的委托任务提醒', value: 9, previous: 8 },
      { label: '被过滤、没有打扰你的事件', value: 6, previous: 2 },
    ])
    expect(group(s, 'triage').figures).toEqual([
      { label: '被过滤的事件', value: 8, previous: 3 },
      { label: '其中被你找回', value: 2, previous: 1 },
    ])
    // Pending and unrequested steps appear only when there are any.
    expect(group(s, 'reports').figures.map((f) => f.label)).not.toContain('整理中')
  })

  test('warnings need the minimum count, then trip at the stated shares', () => {
    const min = summaryThresholds.minimum
    // One restored event out of one filtered is 100% but not enough to judge.
    expect(group(summary({ triage: { filtered: 0, restored: 1 } }), 'triage').warnings).toEqual([])
    expect(
      group(summary({ triage: { filtered: min - 2, restored: 1 } }), 'triage').warnings,
    ).toEqual([])
    const [triage] = group(summary({ triage: { filtered: 4, restored: 1 } }), 'triage').warnings
    expect(triage).toBe(
      '过滤掉的事件有 20% 被你找了回来，分诊可能过滤得太多。被过滤的事件在「对话与事件」的事件列表里标为「已过滤」，在持续任务的时间线里标为「已跳过」；要停用分诊，打开「通知渠道与路由设置」，取消勾选「过滤重复和没有新信息的事件」。',
    )
    expect(group(summary({ triage: { filtered: 5, restored: 1 } }), 'triage').warnings).toEqual([])

    const [unread] = group(
      summary({ investigation: { notified: 5, unread: 1 } }),
      'investigation',
    ).warnings
    expect(unread).toBe(
      '有 20% 的调查没能读到 GitHub 详情，监听凭证的读取权限可能不够。可在「配置 → 监听与收件箱」的仓库卡片上点「检查读取权限」核对。',
    )
    // Expired summaries do not count toward the share or the minimum.
    const expired = group(
      summary({ investigation: { notified: 6, unread: 1, expired: 2 } }),
      'investigation',
    )
    expect(expired.warnings).toEqual([])
    expect(expired.notes).toEqual([
      '其中 2 条的正文已过保留期，看不出当时是否读到了详情，没有计入上面的比例。',
    ])

    const reports = group(
      summary({
        reports: { completed: 10, ready: 4, raw: 1, decisions: 6, answered: 5, recommended: 2 },
      }),
      'reports',
    ).warnings
    expect(reports).toEqual([
      '有 20% 的执行没能整理成汇报，你仍在读不少原始结果。',
      '你的回答里只有 40% 选了推荐项，汇报提的问题或给的推荐可能不对路。',
    ])
    expect(
      group(
        summary({
          reports: { completed: 10, ready: 4, answered: 4, decisions: 4, recommended: 0 },
        }),
        'reports',
      ).warnings,
    ).toEqual([])
    expect(
      group(
        summary({ reports: { completed: 6, ready: 6, answered: 6, decisions: 6, recommended: 3 } }),
        'reports',
      ).warnings,
    ).toEqual([])
  })

  test('expired reports are set apart rather than read as no decision', () => {
    const g = group(summary({ reports: { completed: 3, ready: 3, expired: 3 } }), 'reports')
    expect(g.sentence).toBe(
      '近 7 天派工共完成 3 次执行，3 次整理成了汇报。之前的 7 天没有完成的派工。',
    )
    expect(g.notes).toEqual(['另有 3 份汇报的正文已过保留期，看不出是否提了问题，没有计入问题数。'])
  })

  test('the coverage explains retention and when the new facts began', () => {
    const old = summary({}, {}, { retentionDays: 30 })
    const lines = summaryCoverage(old)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe(
      '本机正文保留 30 天。过期记录的正文会被清除，投递和过滤状态仍然保留，所以通知和分诊照常计入；调查和汇报里正文已清除的部分单独说明，不当作没有问题。',
    )
    const recent = summaryCoverage(summary({}, {}, { recordedSince: '2026-11-06T04:00:00.000Z' }))
    expect(recent[3]).toMatch(
      /^「仍然提醒」找回的委托提醒，以及你对派工问题的回答，从 .+ 起才开始记录。近 7 天和之前的 7 天里早于这个时间的记录没有这两项，找回数和回答数会偏少。$/,
    )
    const inPrevious = summaryCoverage(
      summary({}, {}, { recordedSince: '2026-11-01T04:00:00.000Z' }),
    )
    expect(inPrevious[3]).toContain('之前的 7 天里早于这个时间')
    expect(inPrevious[3]).not.toContain('近 7 天和')
  })
})
