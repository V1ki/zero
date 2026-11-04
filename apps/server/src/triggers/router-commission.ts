import { randomBytes } from 'node:crypto'
import type { TriggerStore } from '@zero-os/observe'
import {
  type CommissionChange,
  type CommissionGrant,
  type CommissionGrantsView,
  type CommissionOperator,
  type CommissionScope,
  type MandateTarget,
  type TriggerConversationAnswer,
  TriggerSettingsConflictError,
} from '@zero-os/shared'
import {
  type CommissionCatalog,
  type CommissionIntent,
  applyCommissionChange,
  buildCommissionChange,
  changedRulePlatforms,
  commissionIntent,
  commissionIntents,
  createCommissionPlanner,
  describeCommission,
} from './commission-plan'
import { type AgentDependencies, TriggerAgentError } from './event-agent'
import { MandateInputError } from './mandate-input'
import type { MandateService } from './mandate-service'

type Registry = Pick<MandateService, 'getConfig' | 'saveConfig' | 'targets'>
type Principal = CommissionOperator | 'web'
function documents(mandates: CommissionCatalog['mandates']) {
  return [
    ...new Map(
      mandates.flatMap((m) => (m.archive ? [[JSON.stringify(m.archive), m.archive] as const] : [])),
    ).values(),
  ]
}
function sameDoc(a: CommissionGrant['archive'], b: CommissionGrant['archive']) {
  return !!a && !!b && a.channelId === b.channelId && a.documentId === b.documentId
}
const sameSource = (a: CommissionScope, b: CommissionScope) =>
  a.source === b.source && a.scope === b.scope
function sameOperator(a: MandateTarget, b: MandateTarget) {
  return (
    !!a.operatorId &&
    a.platform === b.platform &&
    a.channelId === b.channelId &&
    a.peerId === b.peerId &&
    a.operatorId === b.operatorId
  )
}
function principalKey(actor: Principal) {
  return actor === 'web'
    ? 'web'
    : JSON.stringify([actor.platform, actor.channelId, actor.peerId, actor.operatorId])
}
const confirmCommand = /^确认委托\s+([0-9a-f]{12})$/i
export function isCommissionCommand(text: string) {
  return /^确认委托(?:\s|$)/u.test(text.trim()) || commissionIntent(text) !== null
}

export class RouterCommissionService {
  private readonly drafts: TriggerStore['conversations']['commissions']
  private readonly running = new Map<string, Promise<TriggerConversationAnswer>>()
  private readonly planner: ReturnType<typeof createCommissionPlanner>

  constructor(
    private readonly store: TriggerStore,
    private readonly registry: Registry,
    dependencies: AgentDependencies | ReturnType<typeof createCommissionPlanner>,
    private readonly now: () => number = Date.now,
  ) {
    this.drafts = store.conversations.commissions
    this.planner =
      typeof dependencies === 'function' ? dependencies : createCommissionPlanner(dependencies)
  }

  private sources() {
    const { settings, revision } = this.store.getSettings()
    return {
      revision,
      items: [
        ...settings.github.repositories
          .filter((r) => r.enabled)
          .map((r) => ({ source: 'github' as const, scope: r.name.toLowerCase(), label: r.name })),
        ...settings.wxarc.sessions
          .filter((s) => s.enabled)
          .map((s) => ({ source: 'wxarc' as const, scope: s.id, label: s.name })),
      ],
    }
  }

  async grants(): Promise<CommissionGrantsView> {
    const targets = await this.registry.targets()
    const { settings } = this.registry.getConfig()
    return {
      projects: settings.projects.map(({ id, name }) => ({ id, name })),
      archives: documents(settings.mandates),
      ...this.drafts.grants(),
      scopes: this.sources().items,
      operators: targets.targets.flatMap((t) =>
        t.operatorId ? [{ ...t, operatorId: t.operatorId }] : [],
      ),
    }
  }

  async saveGrants(raw: unknown) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('revision' in raw) ||
      !('grants' in raw) ||
      !Array.isArray(raw.grants) ||
      raw.grants.length > 200 ||
      !Number.isSafeInteger(raw.revision)
    )
      throw new MandateInputError(400, '无效的委托管理授权。')
    const available = await this.grants()
    if (raw.revision !== available.revision) throw new TriggerSettingsConflictError()
    const grants: CommissionGrant[] = []
    for (const row of raw.grants) {
      if (!row || typeof row !== 'object' || !row.operator || typeof row.operator !== 'object')
        throw new MandateInputError(400, '请选择具体的操作者和来源。')
      const prior = available.grants.find((g) => JSON.stringify(g) === JSON.stringify(row))
      if (prior) {
        if (grants.some((g) => sameSource(g, prior) && sameOperator(g.operator, prior.operator)))
          throw new MandateInputError(400, '授权重复。')
        grants.push(prior)
        continue
      }
      const operator = available.operators.find((t) => sameOperator(t, row.operator))
      const source = available.scopes.find((s) => sameSource(s, row))
      if (
        !operator ||
        !source ||
        grants.some((g) => sameSource(g, source) && sameOperator(g.operator, operator))
      )
        throw new MandateInputError(400, '请使用当前可用且不重复的会话、操作者和监听来源。')
      const { label, ...identity } = operator
      if (row.targets !== undefined && (!Array.isArray(row.targets) || row.targets.length > 3))
        throw new MandateInputError(400, '请选择最多三个已验证的提醒目标。')
      const targets: MandateTarget[] = []
      for (const target of row.targets ?? []) {
        const match = target && available.operators.find((t) => sameOperator(t, target))
        if (!match || targets.some((t) => sameOperator(t, match)))
          throw new MandateInputError(400, '提醒目标不可用或重复。')
        const { label, ...value } = match
        targets.push(value)
      }
      const archive = available.archives.find((d) => sameDoc(d, row.archive))
      const project = available.projects.find((p) => p.id === row.projectId)
      if ((row.archive && !archive) || (row.projectId && !project))
        throw new MandateInputError(400, '请选择已配置的项目或归档文档。')
      grants.push({
        operator: identity,
        source: source.source,
        scope: source.scope,
        ...(targets.length ? { targets } : {}),
        ...(archive ? { archive } : {}),
        ...(project ? { projectId: project.id } : {}),
      })
    }
    if (!this.drafts.setGrants(grants, available.revision)) throw new TriggerSettingsConflictError()
    return { ...available, grants, revision: available.revision + 1 }
  }

  private async options(actor: Principal) {
    // Resolve live bindings first. Read all versioned local grants synchronously afterwards.
    const { targets } = await this.registry.targets()
    const current = this.registry.getConfig()
    const source = this.sources()
    const grants = this.drafts.grants()
    const bound = actor === 'web' || targets.some((t) => sameOperator(t, actor))
    const permissions =
      actor === 'web' || !bound
        ? []
        : grants.grants.filter(
            (g) => sameOperator(g.operator, actor) && source.items.some((s) => sameSource(s, g)),
          )
    const scopes = source.items.filter(
      (s) => actor === 'web' || permissions.some((g) => sameSource(g, s)),
    )
    const mandates = current.settings.mandates.filter(
      (m) =>
        actor === 'web' ||
        (permissions.some((g) => sameSource(g, m)) && this.drafts.owned(principalKey(actor), m)),
    )
    const projects = current.settings.projects.filter(
      (p) =>
        actor === 'web' ||
        (permissions.some((g) => g.projectId === p.id) &&
          current.settings.mandates
            .filter((m) => m.projectId === p.id)
            .every((m) => permissions.some((g) => g.projectId === p.id && sameSource(g, m)))),
    )
    const catalog: CommissionCatalog = {
      sources: scopes,
      mandates,
      projects,
      targets: targets.filter(
        (t) =>
          actor === 'web' ||
          sameOperator(t, actor) ||
          permissions.some((g) => g.targets?.some((v) => sameOperator(v, t))),
      ),
      archives: documents(current.settings.mandates).filter(
        (d) => actor === 'web' || permissions.some((g) => sameDoc(g.archive, d)),
      ),
    }
    return {
      current,
      catalog,
      permissions,
      sourceRevision: source.revision,
      grantRevision: grants.revision,
    }
  }

  async prepare(
    actor: Principal,
    requestId: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<TriggerConversationAnswer | null> {
    const intent = commissionIntent(question)
    return intent ? this.prepareDraft(actor, requestId, question, intent, signal) : null
  }

  /** The main Web loop supplies the operation; its planner still reads the original user turn. */
  prepareFromIntent(
    requestId: string,
    question: string,
    intent: CommissionIntent,
    signal?: AbortSignal,
  ): Promise<TriggerConversationAnswer> {
    if (!commissionIntents.includes(intent))
      throw new MandateInputError(400, '不支持这项委托操作。')
    return this.prepareDraft('web', requestId, question, intent, signal)
  }

  private async prepareDraft(
    actor: Principal,
    requestId: string,
    question: string,
    intent: CommissionIntent,
    signal?: AbortSignal,
  ): Promise<TriggerConversationAnswer> {
    const principal = principalKey(actor)
    const key = JSON.stringify([principal, requestId, question])
    const active = this.running.get(key)
    if (active) return active
    const result = (async () => {
      const { current, catalog, permissions, sourceRevision, grantRevision } =
        await this.options(actor)
      if (!catalog.sources.length && (actor !== 'web' || intent === 'create'))
        return {
          text:
            actor === 'web'
              ? '请先在监听设置中启用要跟踪的来源。'
              : '当前会话及操作者没有可用的跟踪来源授权。',
        }
      const existing = this.drafts.find(principal, requestId)
      if (existing) {
        if (existing.question !== question)
          throw new MandateInputError(409, '请求标识已用于其他委托。')
        if (
          (actor !== 'web' && existing.grantRevision !== grantRevision) ||
          existing.sourceRevision !== sourceRevision ||
          this.status(actor, existing.preview.code) !== 'pending'
        )
          return { text: '此委托草案已处理或失效。' }
        return { text: '请核对委托草案。', commission: existing.preview }
      }
      if (this.drafts.redacted(principal, requestId)) return { text: '此委托草案已处理或失效。' }
      const raw = await this.planner(question, intent, catalog, signal)
      if (signal?.aborted) throw new TriggerAgentError('委托草案已取消。')
      if (
        this.store.getSettings().revision !== sourceRevision ||
        this.registry.getConfig().revision !== current.revision ||
        (actor !== 'web' && this.drafts.grants().revision !== grantRevision)
      )
        throw new MandateInputError(409, '授权或配置已变更，请重新提出委托。')
      const change = buildCommissionChange(intent, raw, catalog, current, question)
      if ('clarify' in change) return { text: change.clarify }
      if (actor !== 'web' && !this.allowedChange(change, catalog, permissions))
        throw new MandateInputError(409, '此委托的来源、项目、文档和提醒会话需要匹配同一授权。')
      const preview = {
        ...describeCommission(change, catalog),
        code: randomBytes(6).toString('hex'),
        expiresAt: this.now() + 10 * 60_000,
      }
      const saved = this.drafts.save({
        principal,
        requestId,
        question,
        change,
        preview,
        revision: current.revision,
        grantRevision,
        sourceRevision,
      })
      return {
        text: '请核对委托范围和提醒去向，草案在十分钟内可以确认。',
        commission: saved.preview,
      }
    })()
    this.running.set(key, result)
    try {
      return await result
    } finally {
      this.running.delete(key)
    }
  }

  status(actor: Principal, code: string): 'pending' | 'applied' | 'expired' {
    const draft = this.drafts.get(principalKey(actor), code)
    if (!draft) return 'expired'
    if (draft.applied) return 'applied'
    if (
      this.now() >= draft.preview.expiresAt ||
      this.store.getSettings().revision !== draft.sourceRevision ||
      this.registry.getConfig().revision !== draft.revision ||
      (actor !== 'web' && this.drafts.grants().revision !== draft.grantRevision)
    )
      return 'expired'
    return 'pending'
  }

  async confirm(actor: Principal, code: string, recordReceipt?: () => void) {
    const draft = this.drafts.get(principalKey(actor), code)
    if (!draft) throw new MandateInputError(409, '此会话和操作者没有这项待确认草案。')
    if (draft.applied) {
      recordReceipt?.()
      return
    }
    const check = () => {
      if (this.status(actor, code) !== 'pending')
        throw new MandateInputError(409, '草案已失效或配置已更新，请重新提出委托。')
    }
    check()
    if (actor !== 'web') {
      const { catalog, permissions } = await this.options(actor)
      if (!this.allowedChange(draft.change, catalog, permissions))
        throw new MandateInputError(409, '会话、来源或委托授权已失效。')
    }
    try {
      await this.registry.saveConfig(
        applyCommissionChange(this.registry.getConfig(), draft.change),
        {
          before: check,
          after: () => {
            this.drafts.applied(draft)
            recordReceipt?.()
          },
        },
      )
    } catch (err) {
      if (!this.drafts.get(principalKey(actor), code)?.applied) throw err
      recordReceipt?.()
    }
  }

  private allowedChange(
    change: CommissionChange,
    catalog: CommissionCatalog,
    permissions: CommissionGrant[],
  ) {
    if (change.kind === 'project') {
      const previous = catalog.projects.find((p) => p.id === change.project.id)
      if (!previous) return false
      const destinations = changedRulePlatforms(previous.policy, change.project.policy)
      const members = this.registry
        .getConfig()
        .settings.mandates.filter((m) => m.projectId === previous.id)
      return [...destinations].every(
        (platform) =>
          permissions.some(
            (g) =>
              g.projectId === previous.id &&
              (g.operator.platform === platform || g.targets?.some((t) => t.platform === platform)),
          ) &&
          members.every((m) => {
            const grant = permissions.find((g) => g.projectId === previous.id && sameSource(g, m))
            const target = m.targets.find((t) => t.platform === platform)
            return (
              !!grant &&
              !!target &&
              (sameOperator(grant.operator, target) ||
                !!grant.targets?.some((t) => sameOperator(t, target)))
            )
          }),
      )
    }
    const m = change.mandate
    const grant = permissions.find((g) => sameSource(g, m))
    return (
      !!grant &&
      (!m.projectId ||
        (grant.projectId === m.projectId && catalog.projects.some((p) => p.id === m.projectId))) &&
      (!m.archive ||
        (sameDoc(grant.archive, m.archive) &&
          catalog.archives.some((d) => sameDoc(d, m.archive ?? undefined)))) &&
      m.targets.every(
        (t) =>
          (sameOperator(t, grant.operator) || grant.targets?.some((v) => sameOperator(v, t))) &&
          catalog.targets.some((v) => sameOperator(v, t)),
      ) &&
      (change.kind === 'create' || catalog.mandates.some((item) => item.id === m.id))
    )
  }

  async handleIm(
    actor: CommissionOperator & { isDirect?: boolean },
    messageId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!isCommissionCommand(text)) return null
    if (!actor.operatorId || !messageId || messageId.length > 512)
      return '需要可核实的账号、会话和上游消息编号才能处理委托。'
    try {
      if (/^确认委托(?:\s|$)/u.test(text.trim())) {
        const match = confirmCommand.exec(text.trim())
        if (!match) return '请完整回复「确认委托 草案编号」。'
        await this.confirm(actor, match[1].toLowerCase())
        return '委托已确认。'
      }
      const answer = await this.prepare(actor, messageId, text, signal)
      if (!answer?.commission) return answer?.text ?? null
      const p = answer.commission
      return [
        p.title,
        ...p.details,
        `有效期十分钟。核对后请在本会话回复「确认委托 ${p.code}」。`,
      ].join('\n')
    } catch (err) {
      if (err instanceof MandateInputError || err instanceof TriggerAgentError) return err.message
      if (err instanceof TriggerSettingsConflictError) return '配置已更新，请重新提出委托。'
      throw err
    }
  }
}
