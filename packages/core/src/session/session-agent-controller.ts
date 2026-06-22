import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelRouter, ResolvedModel } from '@zero-os/model'
import type {
  Message,
  RunningToolAbortRequestStatus,
  Session as SessionData,
  ToolContext,
  ToolLogger,
} from '@zero-os/shared'
import { Agent, type AgentConfig, type AgentObservability } from '../agent/agent'
import { AgentControl, type AgentSnapshot } from '../agent/agent-control'
import { CONTEXT_PARAMS } from '../agent/params'
import type { ToolRegistry } from '../tool/registry'
import {
  type BackgroundToolCompletionEvent,
  BackgroundToolTaskManager,
} from './background-tool-tasks'
import { createLiveDocHandle } from './live-doc'
import { SessionRunningToolRegistry, requestSessionRunningToolAbort } from './running-tool-registry'
import type { SessionDeps } from './session-types'

export interface SessionAgentRuntimeInitOptions {
  activeModel?: ResolvedModel
  getCurrentSnapshotId(): string | undefined
  onContextCompressed: NonNullable<AgentObservability['onContextCompressed']>
}

export class SessionAgentRuntimeController {
  private agent: Agent | null = null
  private lastAgentConfig: AgentConfig | null = null
  private agentControl: AgentControl
  private runningToolRegistry = new SessionRunningToolRegistry()
  private backgroundToolTasks: BackgroundToolTaskManager
  private liveDocs = new Map<string, string>()

  constructor(
    private readonly options: {
      data: SessionData
      modelRouter: ModelRouter
      toolRegistry: ToolRegistry
      deps: SessionDeps
      logger: ToolLogger
      onBackgroundToolCompletion(event: BackgroundToolCompletionEvent): Promise<void> | void
    },
  ) {
    this.agentControl = new AgentControl({
      tracer: options.deps.tracer,
      logger: options.logger,
    })
    this.backgroundToolTasks = new BackgroundToolTaskManager({
      sessionId: options.data.id,
      logger: options.logger,
      secretFilter: options.deps.secretFilter,
      channelBinding: options.data.channelId
        ? {
            channelName: options.data.channelName ?? options.data.source,
            channelId: options.data.channelId,
            participantId: options.data.participantId,
            deliveryChannelId: options.data.channelId,
          }
        : undefined,
      emitBusEvent: (topic, data) => options.deps.bus?.emit(topic, data),
      onComplete: options.onBackgroundToolCompletion,
    })
  }

  isInitialized(): boolean {
    return !!this.agent
  }

  canRefresh(): boolean {
    return !!this.agent && !!this.lastAgentConfig
  }

  getAgent(): Agent | null {
    return this.agent
  }

  getAgentConfig(): AgentConfig | null {
    return this.lastAgentConfig
  }

  getAgentName(): string {
    return this.lastAgentConfig?.name ?? 'zero'
  }

  init(config: AgentConfig, initOptions: SessionAgentRuntimeInitOptions): Agent {
    this.lastAgentConfig = config
    this.agent = createSessionAgentRuntime({
      config,
      data: this.options.data,
      activeModel: initOptions.activeModel,
      modelRouter: this.options.modelRouter,
      toolRegistry: this.options.toolRegistry,
      deps: this.options.deps,
      logger: this.options.logger,
      agentControl: this.agentControl,
      runningToolRegistry: this.runningToolRegistry,
      backgroundToolTasks: this.backgroundToolTasks,
      liveDocs: this.liveDocs,
      getCurrentSnapshotId: initOptions.getCurrentSnapshotId,
      onContextCompressed: initOptions.onContextCompressed,
    })
    return this.agent
  }

  reinitialize(initOptions: SessionAgentRuntimeInitOptions): void {
    if (!this.lastAgentConfig || !this.agent) return
    this.init(this.lastAgentConfig, initOptions)
  }

  abortRunningTool(messages: Message[], toolUseId: string): RunningToolAbortRequestStatus {
    return requestSessionRunningToolAbort({
      registry: this.runningToolRegistry,
      messages,
      toolUseId,
      reason: 'Command aborted by user from Session Detail.',
    })
  }

  getSubAgentSnapshot(): AgentSnapshot[] {
    return this.agentControl.getSnapshot()
  }

  restoreSubAgentSnapshot(snapshot: AgentSnapshot[]): void {
    this.agentControl.restoreSnapshot(snapshot)
  }
}

function createSessionAgentRuntime(options: {
  config: AgentConfig
  data: SessionData
  activeModel?: ResolvedModel
  modelRouter: ModelRouter
  toolRegistry: ToolRegistry
  deps: SessionDeps
  logger: ToolLogger
  agentControl: AgentControl
  runningToolRegistry: SessionRunningToolRegistry
  backgroundToolTasks: BackgroundToolTaskManager
  liveDocs: Map<string, string>
  getCurrentSnapshotId: () => string | undefined
  onContextCompressed: NonNullable<AgentObservability['onContextCompressed']>
}): Agent {
  const resolved =
    options.activeModel ??
    options.modelRouter.getDefaultModel() ??
    options.modelRouter.getCurrentModel()
  if (!resolved) {
    throw new Error('No active model available for session.')
  }

  const closureResolved = options.deps.taskClosureModel
    ? options.modelRouter.resolveModel(options.deps.taskClosureModel)
    : undefined
  const contextCompactionResolved = options.deps.contextCompactionModel
    ? options.modelRouter.resolveModel(options.deps.contextCompactionModel)
    : undefined

  const projectRoot = options.deps.projectRoot ?? process.cwd()
  const workspacePath = ensureSessionWorkspace(projectRoot, options.config.name)

  options.agentControl.setInstrumentation(options.deps.tracer, options.logger)

  return new Agent(
    options.config,
    resolved.adapter,
    options.toolRegistry,
    createSessionToolContext({
      data: options.data,
      resolved,
      modelRouter: options.modelRouter,
      deps: options.deps,
      logger: options.logger,
      agentControl: options.agentControl,
      runningToolRegistry: options.runningToolRegistry,
      backgroundToolTasks: options.backgroundToolTasks,
      liveDocs: options.liveDocs,
      projectRoot,
      workspacePath,
    }),
    createSessionAgentObservability({
      resolved,
      closureResolved,
      contextCompactionResolved,
      modelRouter: options.modelRouter,
      deps: options.deps,
      getCurrentSnapshotId: options.getCurrentSnapshotId,
      onContextCompressed: options.onContextCompressed,
    }),
    closureResolved?.adapter,
    contextCompactionResolved?.adapter,
  )
}

function ensureSessionWorkspace(projectRoot: string, agentName: string): string {
  const workspacePath = join(projectRoot, '.zero', 'workspace', agentName)
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true })
  }
  return workspacePath
}

function createSessionToolContext(options: {
  data: SessionData
  resolved: ResolvedModel
  modelRouter: ModelRouter
  deps: SessionDeps
  logger: ToolLogger
  agentControl: AgentControl
  runningToolRegistry: SessionRunningToolRegistry
  backgroundToolTasks: BackgroundToolTaskManager
  liveDocs: Map<string, string>
  projectRoot: string
  workspacePath: string
}): ToolContext {
  const observability =
    options.deps.observability && options.deps.metrics
      ? {
          logEvent: options.deps.observability.logEvent.bind(options.deps.observability),
          recordOperation: options.deps.metrics.recordOperation.bind(options.deps.metrics),
        }
      : undefined

  return {
    sessionId: options.data.id,
    currentModel: options.modelRouter.getModelLabel(options.resolved),
    workDir: options.workspacePath,
    projectRoot: options.projectRoot,
    logger: options.logger,
    tracer: options.deps.tracer,
    secretFilter: options.deps.secretFilter,
    observability,
    secretResolver: options.deps.secretResolver,
    memoryRetriever: options.deps.memoryRetriever,
    memoryStore: options.deps.memoryStore,
    channelBinding: options.data.channelId
      ? {
          source: options.data.source,
          channelName: options.data.channelName ?? options.data.source,
          channelId: options.data.channelId,
          participantId: options.data.participantId,
          deliveryChannelId: options.data.channelId,
        }
      : undefined,
    schedulerHandle: options.deps.schedulerHandle,
    scheduleStore: options.deps.scheduleStore,
    agentControl: options.agentControl,
    runningToolRegistry: options.runningToolRegistry,
    backgroundToolTasks: options.backgroundToolTasks,
    liveDocHandle: CONTEXT_PARAMS.memory.liveDocEnabled
      ? createLiveDocHandle(options.liveDocs, options.deps.memoryStore)
      : undefined,
  }
}

function createSessionAgentObservability(options: {
  resolved: ResolvedModel
  closureResolved?: ResolvedModel
  contextCompactionResolved?: ResolvedModel
  modelRouter: ModelRouter
  deps: SessionDeps
  getCurrentSnapshotId: () => string | undefined
  onContextCompressed: NonNullable<AgentObservability['onContextCompressed']>
}): AgentObservability {
  return {
    metrics: options.deps.metrics,
    tracer: options.deps.tracer,
    secretFilter: options.deps.secretFilter,
    bus: options.deps.bus,
    providerName: options.resolved.providerName,
    modelLabel: options.modelRouter.getModelLabel(options.resolved),
    pricing: options.resolved.modelConfig.pricing,
    closureProviderName: options.closureResolved?.providerName,
    closureModelLabel: options.closureResolved
      ? options.modelRouter.getModelLabel(options.closureResolved)
      : undefined,
    closurePricing: options.closureResolved?.modelConfig.pricing,
    contextCompactionProviderName: options.contextCompactionResolved?.providerName,
    contextCompactionModelLabel: options.contextCompactionResolved
      ? options.modelRouter.getModelLabel(options.contextCompactionResolved)
      : undefined,
    contextCompactionPricing: options.contextCompactionResolved?.modelConfig.pricing,
    getCurrentSnapshotId: options.getCurrentSnapshotId,
    onContextCompressed: options.onContextCompressed,
  }
}
