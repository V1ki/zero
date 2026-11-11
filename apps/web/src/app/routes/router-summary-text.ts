import type { RouterSummary, RouterSummaryCounts } from '@zero-os/shared'

/**
 * A share is judged only once at least `minimum` events back it, so one event cannot raise a
 * warning on its own.
 */
export const summaryThresholds = {
  minimum: 5,
  /** Restored ÷ filtered at or above this: triage may filter too much. */
  restored: 0.2,
  /** Could not read details ÷ investigated notifications at or above this. */
  unread: 0.2,
  /** Raw results ÷ completed steps that asked for a report at or above this. */
  raw: 0.2,
  /** Recommended ÷ answered decisions below this. */
  recommended: 0.5,
} as const

export interface SummaryFigure {
  label: string
  value: number
  previous: number
}
export interface SummaryGroup {
  id: 'notifications' | 'triage' | 'investigation' | 'reports'
  heading: string
  sentence: string
  figures: SummaryFigure[]
  warnings: string[]
  notes: string[]
}

const percent = (part: number, whole: number) => Math.round((part / whole) * 100)
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
export const summaryDate = (value: string) => dateFormat.format(new Date(value))

function notifications(days: number, now: RouterSummaryCounts, before: RouterSummaryCounts) {
  const sent = now.notifications.personal + now.notifications.mandate
  const sentBefore = before.notifications.personal + before.notifications.mandate
  const { filtered } = now.triage
  const quiet = filtered
    ? `${sent ? '另有' : '有'} ${filtered} 条事件被分诊过滤，没有打扰你`
    : sent
      ? ''
      : '也没有事件被分诊过滤'
  const sentence =
    `近 ${days} 天${sent ? `发出了 ${sent} 条通知` : '没有发出通知'}${quiet ? `，${quiet}` : ''}。` +
    `之前的 ${days} 天${sentBefore ? `发出了 ${sentBefore} 条` : '没有发出通知'}。`
  return {
    id: 'notifications',
    heading: '通知',
    sentence,
    figures: [
      {
        label: '送到的事件提醒',
        value: now.notifications.personal,
        previous: before.notifications.personal,
      },
      {
        label: '送到的委托任务提醒',
        value: now.notifications.mandate,
        previous: before.notifications.mandate,
      },
      { label: '被过滤、没有打扰你的事件', value: filtered, previous: before.triage.filtered },
    ],
    warnings: [],
    notes: [],
  } satisfies SummaryGroup
}

function triage(days: number, now: RouterSummaryCounts, before: RouterSummaryCounts) {
  const total = now.triage.filtered + now.triage.restored
  const totalBefore = before.triage.filtered + before.triage.restored
  const { restored } = now.triage
  const sentence =
    (total
      ? `近 ${days} 天分诊过滤了 ${total} 条事件，${
          restored
            ? `你点「仍然通知」或「仍然提醒」找回了其中 ${restored} 条。`
            : '你没有找回其中任何一条。'
        }`
      : `近 ${days} 天分诊没有过滤任何事件。`) +
    (totalBefore
      ? `之前的 ${days} 天过滤了 ${totalBefore} 条，找回 ${before.triage.restored} 条。`
      : `之前的 ${days} 天没有过滤事件。`)
  const warnings =
    total >= summaryThresholds.minimum && restored / total >= summaryThresholds.restored
      ? [
          `过滤掉的事件有 ${percent(restored, total)}% 被你找了回来，分诊可能过滤得太多。被过滤的事件在「对话与事件」的事件列表里标为「已过滤」，在持续任务的时间线里标为「已跳过」；要停用分诊，打开「通知渠道与路由设置」，取消勾选「过滤重复和没有新信息的事件」。`,
        ]
      : []
  return {
    id: 'triage',
    heading: '分诊',
    sentence,
    figures: [
      { label: '被过滤的事件', value: total, previous: totalBefore },
      { label: '其中被你找回', value: restored, previous: before.triage.restored },
    ],
    warnings,
    notes: [],
  } satisfies SummaryGroup
}

function investigation(days: number, now: RouterSummaryCounts, before: RouterSummaryCounts) {
  const { notified, unread, unfinished, expired } = now.investigation
  const previous = before.investigation
  const fallbacks = [
    unread && `${unread} 条没能读到详情`,
    unfinished && `${unfinished} 条调查没有完成`,
  ].filter(Boolean)
  const sentence =
    (notified
      ? `近 ${days} 天有 ${notified} 条通知先读取了 GitHub 详情再发出${
          fallbacks.length
            ? `，其中 ${fallbacks.join('、')}，只按事件摘要发出。`
            : expired === notified
              ? '。'
              : '，都读到了详情。'
        }`
      : `近 ${days} 天没有来自「读取 GitHub 详情后提醒」委托的通知。`) +
    (previous.notified
      ? `之前的 ${days} 天有 ${previous.notified} 条，其中 ${previous.unread} 条没能读到详情。`
      : `之前的 ${days} 天没有这类通知。`)
  // Expired summaries cannot say whether they carried a note, so they are not in the share.
  const known = notified - expired
  const warnings =
    known >= summaryThresholds.minimum && unread / known >= summaryThresholds.unread
      ? [
          `有 ${percent(unread, known)}% 的调查没能读到 GitHub 详情，监听凭证的读取权限可能不够。可在「配置 → 监听与收件箱」的仓库卡片上点「检查读取权限」核对。`,
        ]
      : []
  return {
    id: 'investigation',
    heading: '调查',
    sentence,
    figures: [
      { label: '先读取详情的通知', value: notified, previous: previous.notified },
      { label: '没能读到详情', value: unread, previous: previous.unread },
      { label: '调查没有完成', value: unfinished, previous: previous.unfinished },
    ],
    warnings,
    notes: expired
      ? [`其中 ${expired} 条的正文已过保留期，看不出当时是否读到了详情，没有计入上面的比例。`]
      : [],
  } satisfies SummaryGroup
}

function reports(days: number, now: RouterSummaryCounts, before: RouterSummaryCounts) {
  const r = now.reports
  const p = before.reports
  let sentence: string
  if (!r.completed) sentence = `近 ${days} 天没有完成的派工。`
  else {
    sentence = `近 ${days} 天派工共完成 ${r.completed} 次执行，${
      r.ready ? `${r.ready} 次整理成了汇报` : '没有一次整理成汇报'
    }${r.raw ? `，${r.raw} 次整理失败、只给你看了原始结果` : ''}。`
    if (r.decisions)
      sentence += `汇报里提了 ${r.decisions} 个需要你决定的问题，${
        r.answered
          ? `你回答了 ${r.answered} 个，其中 ${r.recommended} 个选的是推荐项。`
          : '你还没有回答。'
      }`
    else if (r.ready > r.expired) sentence += '汇报里没有提需要你决定的问题。'
  }
  sentence += p.completed
    ? `之前的 ${days} 天完成 ${p.completed} 次，提了 ${p.decisions} 个问题。`
    : `之前的 ${days} 天没有完成的派工。`
  const asked = r.ready + r.raw
  const warnings = [
    ...(asked >= summaryThresholds.minimum && r.raw / asked >= summaryThresholds.raw
      ? [`有 ${percent(r.raw, asked)}% 的执行没能整理成汇报，你仍在读不少原始结果。`]
      : []),
    ...(r.answered >= summaryThresholds.minimum &&
    r.recommended / r.answered < summaryThresholds.recommended
      ? [
          `你的回答里只有 ${percent(r.recommended, r.answered)}% 选了推荐项，汇报提的问题或给的推荐可能不对路。`,
        ]
      : []),
  ]
  const optional: SummaryFigure[] = [
    { label: '整理中', value: r.pending, previous: p.pending },
    { label: '没有要求整理', value: r.unrequested, previous: p.unrequested },
  ].filter((figure) => figure.value || figure.previous)
  return {
    id: 'reports',
    heading: '派工汇报',
    sentence,
    figures: [
      { label: '完成的执行', value: r.completed, previous: p.completed },
      { label: '整理成汇报', value: r.ready, previous: p.ready },
      { label: '只显示原始结果', value: r.raw, previous: p.raw },
      ...optional,
      { label: '提出的问题', value: r.decisions, previous: p.decisions },
      { label: '你回答的', value: r.answered, previous: p.answered },
      { label: '选了推荐项', value: r.recommended, previous: p.recommended },
    ],
    warnings,
    notes: r.expired
      ? [`另有 ${r.expired} 份汇报的正文已过保留期，看不出是否提了问题，没有计入问题数。`]
      : [],
  } satisfies SummaryGroup
}

export function summaryGroups(summary: RouterSummary): SummaryGroup[] {
  const { days } = summary
  const now = summary.current.counts
  const before = summary.previous.counts
  return [
    notifications(days, now, before),
    triage(days, now, before),
    investigation(days, now, before),
    reports(days, now, before),
  ]
}

/** What the numbers cover, in the order the page states it. */
export function summaryCoverage(summary: RouterSummary): string[] {
  const { days, current, previous, recordedSince, retentionDays } = summary
  const lines = [
    `统计近 ${days} 天（${summaryDate(current.from)} 至 ${summaryDate(current.to)}），并与之前的 ${days} 天（${summaryDate(previous.from)} 至 ${summaryDate(previous.to)}）对比。`,
    '通知只算真正送到你面前的：网页提醒，以及平台已受理的微信、钉钉、飞书消息；待核对、延后和失败的不算。一次汇总里的每个事件各算一条。分诊按事件到达的时间归入，派工按执行完成或结果送回的时间归入。',
    retentionDays
      ? `本机正文保留 ${retentionDays} 天。过期记录的正文会被清除，投递和过滤状态仍然保留，所以通知和分诊照常计入；调查和汇报里正文已清除的部分单独说明，不当作没有问题。`
      : '本机记录一直保留，统计范围内的记录都完整。',
  ]
  if (recordedSince && recordedSince > previous.from)
    lines.push(
      `「仍然提醒」找回的委托提醒，以及你对派工问题的回答，从 ${summaryDate(recordedSince)} 起才开始记录。${
        recordedSince > current.from ? `近 ${days} 天和之前的 ${days} 天` : `之前的 ${days} 天`
      }里早于这个时间的记录没有这两项，找回数和回答数会偏少。`,
    )
  return lines
}
