import { isDeepStrictEqual } from 'node:util'
import type { TriggerStore } from '@zero-os/observe'
import {
  type MandateArchive,
  type MandateTarget,
  type TriggerMandate,
  type TriggerSettings,
  TriggerSettingsConflictError,
} from '@zero-os/shared'
import { MandateInputError, mandateArchive, mandateInstant, mandateSnapshot } from './mandate-input'
import type { MandateNotificationDecision } from './mandate-policy'

export type MandateTargetOption = MandateTarget & { label: string }
type RetryKind = 'analysis' | 'notify' | 'archive'
interface MandateServiceDependencies {
  store: Pick<TriggerStore, 'getSettings' | 'mandates'>
  listTargets(): readonly MandateTargetOption[] | Promise<readonly MandateTargetOption[]>
  listArchiveChannels(): readonly string[]
  probeArchive(archive: MandateArchive): Promise<{ ok: boolean; reason: string }>
  runtime: {
    preview(
      mandateId: string,
      at: string,
      present: boolean | null,
      urgent?: boolean,
    ): { decision: MandateNotificationDecision; archive: MandateArchive | null }
    retry(matchId: number, kind: RetryKind): boolean
    wakeDeferred(): void
  }
}

function sameChat(a: MandateTarget, b: MandateTarget) {
  return a.platform === b.platform && a.channelId === b.channelId && a.peerId === b.peerId
}

function sameArchive(a: MandateArchive | null, b: MandateArchive | null) {
  return a?.channelId === b?.channelId && a?.documentId === b?.documentId
}

/** Local administrator facade. IM callers must first authorize the actor and limit visibility to their mandate. */
export function createMandateService({
  store,
  listTargets,
  listArchiveChannels,
  probeArchive,
  runtime,
}: MandateServiceDependencies) {
  const records = store.mandates
  const getTask = (id: number) => {
    const task = records.getTask(id)
    if (!task) throw new MandateInputError(404, '找不到这项任务。')
    return task
  }
  async function verifyDocument(raw: unknown) {
    const archive = mandateArchive(raw)
    if (!listArchiveChannels().includes(archive.channelId))
      throw new MandateInputError(400, '请选择当前可用的飞书归档渠道。')
    // Only release a capability bit to the client. Provider responses may contain private data.
    const result = await probeArchive(archive)
    return { writable: result.ok === true }
  }
  function assertSource(mandate: TriggerMandate, settings: TriggerSettings) {
    const allowed =
      mandate.source === 'github'
        ? settings.github.repositories.some(
            (r) =>
              r.name.toLowerCase() === mandate.scope.toLowerCase() &&
              (!mandate.enabled || r.enabled),
          )
        : settings.wxarc.sessions.some(
            (s) => s.id === mandate.scope && (!mandate.enabled || s.enabled),
          )
    if (!allowed)
      throw new MandateInputError(400, '请先在事件来源中选择并启用委托要监听的仓库或微信会话。')
  }
  const getConfig = () => records.getSettings()
  async function saveConfig(raw: unknown, commit?: { before(): void; after(): void }) {
    const { settings, revision } = mandateSnapshot(raw)
    const previous = getConfig()
    if (revision !== previous.revision) throw new TriggerSettingsConflictError()
    const sources = store.getSettings()
    const docs = new Map<string, MandateArchive>()
    const notify: MandateTarget[] = []
    for (const row of settings.mandates) {
      const old = previous.settings.mandates.find((m) => m.id === row.id)
      const projectPolicy = settings.projects.find((p) => p.id === row.projectId)?.policy
      const oldProjectPolicy = previous.settings.projects.find(
        (p) => p.id === old?.projectId,
      )?.policy
      // Editing or enabling an ordered rule may only select the mandate's own recipients.
      // Revoking a recipient remains possible even if an unchanged rule will now defer.
      if (
        row.enabled &&
        (!old?.enabled ||
          old.projectId !== row.projectId ||
          !isDeepStrictEqual(row.policy.rules, old.policy.rules) ||
          !isDeepStrictEqual(projectPolicy?.rules, oldProjectPolicy?.rules))
      ) {
        for (const { destination } of [
          ...(row.policy.rules ?? []),
          ...(projectPolicy?.rules ?? []),
        ]) {
          if (
            (destination === 'weixin' || destination === 'feishu' || destination === 'dingtalk') &&
            !row.targets.some((target) => target.platform === destination)
          ) {
            throw new MandateInputError(
              400,
              `请先为委托「${row.name}」选择情境规则所需的具体接收会话。`,
            )
          }
        }
      }
      const contextChanged =
        !old ||
        !isDeepStrictEqual(
          { ...row, name: '', targets: [], archive: null },
          { ...old, name: '', targets: [], archive: null },
        ) ||
        !isDeepStrictEqual(projectPolicy, oldProjectPolicy)
      const newTargets = row.targets.filter(
        (target) =>
          !old?.targets.some(
            (existing) => sameChat(existing, target) && existing.operatorId === target.operatorId,
          ),
      )
      const newArchive = !sameArchive(row.archive, old?.archive ?? null)
      const verifyAll = row.enabled && contextChanged
      if (
        verifyAll ||
        newTargets.length ||
        (row.archive && newArchive) ||
        !old ||
        old.source !== row.source ||
        old.scope !== row.scope
      )
        assertSource(row, sources.settings)
      // A revocation or an edit to an unrelated mandate must also succeed when old grants are offline.
      notify.push(...(verifyAll ? row.targets : newTargets))
      if (row.archive && (verifyAll || newArchive))
        docs.set(JSON.stringify([row.archive.channelId, row.archive.documentId]), row.archive)
    }
    for (const doc of docs.values()) {
      if (!(await verifyDocument(doc)).writable)
        throw new MandateInputError(400, '未能核实所选飞书文档的编辑权限。请检查文档授权。')
    }
    if (notify.length) {
      const bound = await listTargets()
      for (const grant of notify) {
        if (!bound.some((b) => sameChat(b, grant) && b.operatorId === grant.operatorId))
          throw new MandateInputError(400, '请选择已绑定的可用会话及这个会话已验证的操作者。')
      }
    }
    // The transaction compares the revision again, including after asynchronous permission probes.
    const next = records.saveSettings(settings, revision, {
      before() {
        if (store.getSettings().revision !== sources.revision)
          throw new TriggerSettingsConflictError()
        commit?.before()
      },
      after() {
        commit?.after()
      },
    })
    if (next !== revision) runtime.wakeDeferred()
    return getConfig()
  }
  return {
    getConfig,
    saveConfig,
    verifyDocument,
    async targets() {
      const bound = await listTargets()
      return {
        targets: bound.map(({ platform, channelId, peerId, label, operatorId }) => ({
          platform,
          channelId,
          peerId,
          label,
          ...(operatorId ? { operatorId } : {}),
        })),
        archiveChannels: listArchiveChannels().map((channelId) => ({
          channelId,
          label: channelId,
        })),
      }
    },
    getTask,
    listTasks: (limit?: number, beforeId?: number) => records.listTasks(limit, beforeId),
    listRecords: (limit?: number, beforeId?: number, inboxId?: number) =>
      records.listMatches(limit, beforeId, inboxId),
    listAudit: (limit?: number, beforeId?: number) => records.listAudit(limit, beforeId),
    setPaused(taskId: number, paused: boolean) {
      getTask(taskId)
      if (!records.setTaskPaused(taskId, paused))
        throw new MandateInputError(409, '任务的原委托已终止或授权已变更。')
      runtime.wakeDeferred()
      return getTask(taskId)
    },
    preview(mandateId: string, at: string, present: boolean | null, urgent?: boolean) {
      if (!getConfig().settings.mandates.some((m) => m.id === mandateId))
        throw new MandateInputError(404, '找不到要预演的委托。')
      return runtime.preview(mandateId, mandateInstant(at), present, urgent)
    },
    retry(matchId: number, kind: RetryKind) {
      if (!records.getMatch(matchId)) throw new MandateInputError(404, '找不到这条处理记录。')
      if (!runtime.retry(matchId, kind))
        throw new MandateInputError(409, '只可重试已明确失败的步骤。请核对处理记录。')
      return { accepted: true as const }
    },
  }
}

export type MandateService = ReturnType<typeof createMandateService>
