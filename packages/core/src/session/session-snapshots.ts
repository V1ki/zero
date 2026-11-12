import type { ModelRouter, ResolvedModel } from '@zero-os/model'
import type { ObservabilityStore, SnapshotEntry, Tracer } from '@zero-os/observe'
import { buildSnapshot } from '../agent/snapshot'

type BuiltSnapshot = Omit<SnapshotEntry, 'ts'>

export interface SessionSnapshotContext {
  model: string
  systemPrompt: string
  tools: string[]
  identityMemory?: string
}

export function buildSessionSnapshotContext(options: {
  activeModel: ResolvedModel | undefined
  modelRouter: ModelRouter
  systemPrompt: string
  toolNames: string[]
  identityMemory?: string
}): SessionSnapshotContext | null {
  const model = getSessionSnapshotModelLabel(options.activeModel, options.modelRouter)
  if (!model || !options.systemPrompt) {
    return null
  }

  return {
    model,
    systemPrompt: options.systemPrompt,
    tools: [...options.toolNames],
    identityMemory: options.identityMemory,
  }
}

export class SessionSnapshotRecorder {
  private currentSnapshotId?: string
  private lastSnapshotContext: SessionSnapshotContext | null = null

  constructor(
    private readonly deps: {
      sessionId: string
      observability?: ObservabilityStore
      tracer?: Tracer
      getAgentName: () => string
    },
  ) {}

  getCurrentSnapshotId(): string | undefined {
    return this.currentSnapshotId
  }

  ensureCurrentContextSnapshot(context: SessionSnapshotContext | null): void {
    if (!context) return

    if (!this.currentSnapshotId || !this.lastSnapshotContext) {
      this.writeSnapshot('session_start', context)
      return
    }

    if (
      this.lastSnapshotContext.model === context.model &&
      this.lastSnapshotContext.systemPrompt === context.systemPrompt &&
      this.lastSnapshotContext.identityMemory === context.identityMemory &&
      SessionSnapshotRecorder.sameStringArray(this.lastSnapshotContext.tools, context.tools)
    ) {
      return
    }

    const trigger = SessionSnapshotRecorder.sameStringArray(
      this.lastSnapshotContext.tools,
      context.tools,
    )
      ? 'context_updated'
      : 'tools_changed'
    this.writeSnapshot(trigger, context)
  }

  restoreFromLogger(): void {
    const lastSnapshot = this.deps.observability?.readSessionSnapshots(this.deps.sessionId).at(-1)
    if (!lastSnapshot) return

    this.currentSnapshotId = lastSnapshot.id
    this.lastSnapshotContext = SessionSnapshotRecorder.snapshotContextFromEntry(lastSnapshot)
  }

  writeSnapshot(trigger: string, context: SessionSnapshotContext): string | undefined {
    if (!this.deps.observability) return undefined

    const snapshot = buildSnapshot({
      sessionId: this.deps.sessionId,
      trigger,
      model: context.model,
      systemPrompt: context.systemPrompt,
      tools: [...context.tools],
      identityMemory: context.identityMemory,
      parentSnapshot: this.currentSnapshotId,
    })

    if (!this.deps.tracer) {
      this.updateCurrentSnapshot(snapshot, context)
      return snapshot.id
    }

    const snapshotSpan = this.deps.tracer.startSpan(
      this.deps.sessionId,
      `snapshot:${trigger}`,
      undefined,
      {
        kind: 'snapshot',
        agentName: this.deps.getAgentName(),
        data: {
          snapshot: {
            id: snapshot.id,
            sessionId: snapshot.sessionId,
            trigger: snapshot.trigger,
            model: snapshot.model,
            parentSnapshot: snapshot.parentSnapshot,
            systemPrompt: snapshot.systemPrompt,
            tools: snapshot.tools,
            identityMemory: snapshot.identityMemory,
          },
        },
      },
    )
    this.deps.tracer.endSpan(snapshotSpan.id, 'success')
    this.updateCurrentSnapshot(snapshot, context)
    return snapshot.id
  }

  private updateCurrentSnapshot(snapshot: BuiltSnapshot, context: SessionSnapshotContext): void {
    this.currentSnapshotId = snapshot.id
    this.lastSnapshotContext = {
      model: context.model,
      systemPrompt: context.systemPrompt,
      tools: [...context.tools],
      identityMemory: context.identityMemory,
    }
  }

  private static sameStringArray(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }

  private static snapshotContextFromEntry(entry?: SnapshotEntry): SessionSnapshotContext | null {
    if (!entry?.model || !entry.systemPrompt) {
      return null
    }

    return {
      model: entry.model,
      systemPrompt: entry.systemPrompt,
      tools: entry.tools ?? [],
      identityMemory: entry.identityMemory,
    }
  }
}

function getSessionSnapshotModelLabel(
  activeModel: ResolvedModel | undefined,
  modelRouter: ModelRouter,
): string | undefined {
  const resolved = activeModel ?? modelRouter.getDefaultModel() ?? modelRouter.getCurrentModel()
  return resolved ? modelRouter.getModelLabel(resolved) : undefined
}
