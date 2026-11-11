import { isTriggerCalendarDate } from '@zero-os/shared'
import type {
  MandateArchive,
  MandateContextRule,
  MandatePolicy,
  MandateTarget,
  TriggerMandate,
  TriggerMandateProject,
  TriggerMandateSnapshot,
} from '@zero-os/shared'

export class MandateInputError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message)
    this.name = 'MandateInputError'
  }
}

function invalid(label: string): never {
  throw new MandateInputError(400, `${label}无效。`)
}

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    invalid('配置对象或字段')
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max: number, mode?: 'optional' | 'multiline') {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /\p{Cc}/u.test(mode === 'multiline' ? value.replace(/[\r\n\t]/g, '') : value) ||
    (mode !== 'optional' && !value.trim())
  )
    invalid(label)
  return value.trim()
}

function id(value: unknown, label: string) {
  const result = text(value, label, 64)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(result)) invalid(label)
  return result
}

function bool(value: unknown, label: string) {
  if (typeof value !== 'boolean') invalid(label)
  return value
}

function oneOf<T extends string>(value: unknown, options: readonly T[], label: string): T {
  return options.find((option) => option === value) ?? invalid(label)
}

function list<T>(value: unknown, max: number, parse: (item: unknown) => T, label: string) {
  if (!Array.isArray(value) || value.length > max) invalid(label)
  return value.map(parse)
}

export function mandateInstant(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) ||
    !isTriggerCalendarDate(value.slice(0, 10))
  )
    invalid('日期时间和时区')
  const time = Date.parse(value)
  if (!Number.isFinite(time)) invalid('日期时间和时区')
  return new Date(time).toISOString()
}

const destinations = ['web', 'weixin', 'feishu', 'dingtalk', 'defer', 'none'] as const
const slots = ['duringWork', 'afterWork', 'offDay', 'awayFallback', 'urgentDestination'] as const

function contextRule(value: unknown): MandateContextRule {
  const row = object(value, ['id', 'name', 'when', 'destination'])
  const criteria = object(row.when, ['period', 'presence', 'urgency', 'quiet'])
  if (!Object.keys(criteria).length) invalid('规则至少需要一个情境条件')
  const when: MandateContextRule['when'] = {}
  if ('period' in criteria)
    when.period = oneOf(criteria.period, ['duringWork', 'afterWork', 'offDay'] as const, '规则时段')
  if ('presence' in criteria)
    when.presence = oneOf(
      criteria.presence,
      ['present', 'away', 'unknown'] as const,
      '规则在场状态',
    )
  if ('urgency' in criteria)
    when.urgency = oneOf(criteria.urgency, ['urgent', 'normal'] as const, '规则紧急程度')
  if ('quiet' in criteria) when.quiet = bool(criteria.quiet, '规则静默条件')
  return {
    id: id(row.id, '规则标识'),
    name: text(row.name, '规则名称', 80),
    when,
    destination: oneOf(row.destination, destinations, '规则提醒位置'),
  }
}

function minutes(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10080)
    invalid(`${label}（0 到 10080 分钟）`)
  return value
}

function policy(value: unknown): MandatePolicy {
  const data = object(value, [
    ...slots,
    'quietStart',
    'quietEnd',
    'digestMinutes',
    'dateOverrides',
    'rules',
    'deadlineLeadMinutes',
  ])
  const result: MandatePolicy = {}
  for (const slot of slots) {
    if (slot in data) result[slot] = oneOf(data[slot], destinations, '提醒位置')
  }
  if ('quietStart' in data || 'quietEnd' in data) {
    const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/
    const start = text(data.quietStart, '静默开始时间', 5)
    const end = text(data.quietEnd, '静默结束时间', 5)
    if (!clock.test(start) || !clock.test(end) || start === end) invalid('静默时段')
    result.quietStart = start
    result.quietEnd = end
  }
  if ('digestMinutes' in data) result.digestMinutes = minutes(data.digestMinutes, '摘要间隔')
  if ('deadlineLeadMinutes' in data)
    result.deadlineLeadMinutes = minutes(data.deadlineLeadMinutes, '临近截止时间提前量')
  if ('rules' in data) {
    result.rules = list(data.rules, 12, contextRule, '情境规则（每层最多 12 条）')
    if (new Set(result.rules.map((rule) => rule.id)).size !== result.rules.length)
      invalid('同一层的规则标识不能重复')
  }
  if ('dateOverrides' in data) {
    const dates = data.dateOverrides
    if (
      !dates ||
      typeof dates !== 'object' ||
      Array.isArray(dates) ||
      Object.keys(dates).length > 730
    )
      invalid('日历例外')
    result.dateOverrides = Object.fromEntries(
      Object.entries(dates).map(([date, type]) => {
        if (!isTriggerCalendarDate(date)) invalid('日历例外日期')
        return [date, oneOf(type, ['work', 'off'] as const, '日历例外类型')]
      }),
    )
  }
  return result
}

export function parseMandateTarget(value: unknown): MandateTarget {
  const data = object(value, ['platform', 'channelId', 'peerId', 'operatorId'])
  return {
    platform: oneOf(data.platform, ['weixin', 'dingtalk', 'feishu'], '提醒平台'),
    channelId: text(data.channelId, '渠道', 256),
    peerId: text(data.peerId, '接收会话', 256),
    ...('operatorId' in data ? { operatorId: text(data.operatorId, '授权操作者', 256) } : {}),
  }
}

export function mandateArchive(value: unknown): MandateArchive {
  const data = object(value, ['channelId', 'documentId'])
  const documentId = text(data.documentId, '飞书文档标识', 128)
  if (!/^[A-Za-z0-9]{1,128}$/.test(documentId)) invalid('飞书 docx 文档标识')
  return { channelId: text(data.channelId, '飞书渠道', 256), documentId }
}

function mandate(value: unknown): TriggerMandate {
  const data = object(value, [
    'id',
    'enabled',
    'name',
    'groupBy',
    'processing',
    'purpose',
    'source',
    'scope',
    'keyword',
    'projectId',
    'targets',
    'archive',
    'policy',
    'deadline',
    'urgent',
  ])
  const targets = list(data.targets, 3, parseMandateTarget, '提醒目标列表')
  if (new Set(targets.map((row) => row.platform)).size !== targets.length)
    throw new MandateInputError(400, '每个平台只能选择一个接收目标。')
  const source = oneOf(data.source, ['github', 'wxarc'] as const, '事件来源')
  const processing =
    'processing' in data
      ? oneOf(data.processing, ['agent', 'direct', 'investigate'] as const, '事件处理方式')
      : undefined
  if (processing === 'investigate' && source !== 'github')
    throw new MandateInputError(400, '只有 GitHub 委托可以选择「读取 GitHub 详情后提醒」。')
  return {
    id: id(data.id, '委托标识'),
    enabled: bool(data.enabled, '启用开关'),
    name: text(data.name, '委托名称', 120),
    purpose: text(data.purpose, '跟踪目的', 2000, 'multiline'),
    source,
    scope: text(data.scope, '监听范围', 256),
    keyword: text(data.keyword, '关键词', 256, 'optional'),
    projectId: data.projectId === null ? null : id(data.projectId, '所属项目'),
    targets,
    ...(processing ? { processing } : {}),
    ...('groupBy' in data
      ? { groupBy: oneOf(data.groupBy, ['thread', 'mandate', 'event'] as const, '任务归组方式') }
      : {}),
    archive: data.archive === null ? null : mandateArchive(data.archive),
    policy: policy(data.policy),
    deadline: data.deadline === null ? null : mandateInstant(data.deadline),
    urgent: bool(data.urgent, '紧急开关'),
  }
}

function project(value: unknown): TriggerMandateProject {
  const data = object(value, ['id', 'name', 'policy'])
  return {
    id: id(data.id, '项目标识'),
    name: text(data.name, '项目名称', 120),
    policy: policy(data.policy),
  }
}

export function mandateSnapshot(raw: unknown): TriggerMandateSnapshot {
  const value = object(raw, ['revision', 'settings'])
  const revision = value.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
    invalid('配置版本')
  const data = object(value.settings, ['mandates', 'projects'])
  const mandates = list(data.mandates, 100, mandate, '委托列表')
  const projects = list(data.projects, 100, project, '项目列表')
  const projectIds = new Set(projects.map((p) => p.id))
  if (
    new Set(mandates.map((m) => m.id)).size !== mandates.length ||
    projectIds.size !== projects.length
  )
    invalid('重复的项目或委托标识')
  if (mandates.some((m) => m.projectId !== null && !projectIds.has(m.projectId)))
    invalid('委托关联的项目')
  return { revision, settings: { mandates, projects } }
}
