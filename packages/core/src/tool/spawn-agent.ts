import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelRouter } from '@zero-os/model'
import type { MetricsDB, SessionEventStore } from '@zero-os/observe'
import type { ToolContext, ToolDefinition, ToolResult } from '@zero-os/shared'
import { generateId, generatePrefixedId } from '@zero-os/shared'
import { Agent, type AgentConfig, type AgentContext, type AgentObservability } from '../agent/agent'
import { buildSystemPrompt } from '../agent/prompt'
import { loadRoles, resolveRole } from '../agent/roles'
import { BaseTool } from './base'
import { supportsToolForModel } from './capabilities'
import { SUB_AGENT_BLOCKED_TOOLS } from './constants'
import { ToolRegistry } from './registry'

interface SpawnAgentInput {
  instruction: string
  label?: string
  mode?: 'standard' | 'interactive'
  role?: string
  agentInstruction?: string
  tools?: string[]
  model?: string
}

export class SpawnAgentTool extends BaseTool {
  name = 'spawn_agent'
  description =
    'Spawn a sub-agent asynchronously. Returns immediately with an agent_id. Use wait_agent later to wait for one or more spawned sub-agents.'
  parameters = {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description: 'The task the sub-agent should execute.',
      },
      label: {
        type: 'string',
        description: 'Optional human-readable label for the sub-agent.',
      },
      mode: {
        type: 'string',
        enum: ['standard', 'interactive'],
        description:
          'Agent execution mode. "standard" completes after the initial instruction. "interactive" waits for additional send_input turns and must be ended with close_agent.',
      },
      role: {
        type: 'string',
        description: 'Optional role ID to use for the sub-agent.',
      },
      agentInstruction: {
        type: 'string',
        description: 'Optional explicit agent instruction for a custom sub-agent.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional allowlist of tool names for the sub-agent. Defaults to all non-blocked tools.',
      },
      model: {
        type: 'string',
        description:
          'Optional model override for this sub-agent. Defaults to the current session model.',
      },
    },
    required: ['instruction'],
  }

  constructor(
    private modelRouter: ModelRouter,
    private baseToolRegistry: ToolRegistry,
    private metrics?: MetricsDB,
    private sessionEvents?: SessionEventStore,
  ) {
    super()
  }

  override toDefinition(): ToolDefinition {
    const definition = super.toDefinition()
    const models = this.modelRouter.getRegistry().listModels()
    const modelLabels = models.map((model) => {
      const label = `${model.providerName}/${model.modelName}`
      const resolved = this.modelRouter.resolveModel(label)
      const capabilities = resolved?.modelConfig.capabilities ?? []
      return capabilities.length > 0 ? `${label} (${capabilities.join(', ')})` : label
    })
    const available = [...this.modelRouter.listModelRoutes(), ...modelLabels]
    const description =
      available.length > 0
        ? `Optional model override for this sub-agent. Defaults to the current session model. Current routes and models: ${available.join(', ')}`
        : this.parameters.properties.model.description

    return {
      ...definition,
      parameters: {
        ...this.parameters,
        properties: {
          ...this.parameters.properties,
          model: { ...this.parameters.properties.model, description },
        },
      },
    }
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    if (!ctx.agentControl) {
      return {
        success: false,
        output: 'Agent control is not available in this session.',
        outputSummary: 'Agent control unavailable',
      }
    }

    const { instruction, label, mode, role, agentInstruction, tools, model } =
      input as SpawnAgentInput
    const trimmedInstruction = instruction.trim()
    const roles = await loadRoles(ctx.projectRoot ?? process.cwd())
    const requestedRoleId = role?.trim()
    const roleDefinition = requestedRoleId ? resolveRole(requestedRoleId, roles) : undefined

    if (requestedRoleId && !roleDefinition) {
      return {
        success: false,
        output: `Unknown sub-agent role: ${requestedRoleId}`,
        outputSummary: 'Unknown sub-agent role',
      }
    }

    const resolvedAgentInstruction =
      agentInstruction?.trim() ||
      roleDefinition?.agentInstruction ||
      'You are a focused sub-agent. Execute the assigned task and report back.'
    const agentLabel = label?.trim() || roleDefinition?.name || 'SubAgent'

    const requestedModel = model?.trim() || roleDefinition?.model
    const resolvedModel = requestedModel
      ? this.modelRouter.resolveModel(requestedModel)
      : ctx.currentModel
        ? this.modelRouter.resolveModel(ctx.currentModel)
        : this.modelRouter.getCurrentModel()
    const adapter = resolvedModel?.adapter ?? this.modelRouter.getAdapter()
    const resolvedModelLabel = resolvedModel
      ? this.modelRouter.getModelLabel(resolvedModel)
      : ctx.currentModel
    const scopedRegistry = this.buildScopedRegistry(
      tools ?? roleDefinition?.defaultTools,
      resolvedModel?.modelConfig,
    )
    const toolDefinitions = scopedRegistry.getDefinitions()

    const subWorkDir = join(
      ctx.workDir,
      'subagents',
      `${this.sanitizeSegment(agentLabel)}-${generateId().slice(0, 8)}`,
    )
    if (!existsSync(subWorkDir)) {
      mkdirSync(subWorkDir, { recursive: true })
    }

    const safeInstructionSummary = ctx.secretFilter
      ? ctx.secretFilter.filter(trimmedInstruction.slice(0, 200))
      : trimmedInstruction.slice(0, 200)
    const subAgentSpan = ctx.tracer?.startSpan(
      ctx.sessionId,
      `sub_agent:${agentLabel}`,
      ctx.currentTraceSpanId,
      {
        kind: 'sub_agent',
        agentName: agentLabel,
        data: {
          role: requestedRoleId,
          model: resolvedModelLabel,
          instruction: safeInstructionSummary,
          spawnedByRequestId: ctx.currentRequestId,
        },
        metadata: {
          model: resolvedModelLabel,
        },
      },
    )

    const toolContext: ToolContext = {
      ...ctx,
      sessionId: ctx.sessionId,
      currentRequestId: undefined,
      currentModel: resolvedModelLabel,
      currentTraceSpanId: subAgentSpan?.id ?? ctx.currentTraceSpanId,
      spawnedByRequestId: ctx.currentRequestId,
      workDir: subWorkDir,
      agentControl: undefined,
      backgroundTaskWait: true,
    }

    // 子代理有自己的事件文件(父会话目录下 sub-<agentId>.jsonl):它的过程事件写进这份文件,
    // 不混入父会话的事件流
    const agentId = generatePrefixedId('agent')
    const spawnedRole = roleDefinition ? requestedRoleId : undefined
    const sessionEvents = this.sessionEvents
    const logFile = sessionEvents?.registerSubagent({
      childSessionId: agentId,
      parentSessionId: ctx.sessionId,
      spawnedByRequestId: ctx.currentRequestId,
      name: agentLabel,
      role: spawnedRole,
    })

    const agentConfig: AgentConfig = {
      name: agentLabel,
      agentInstruction: resolvedAgentInstruction,
      promptMode: roleDefinition?.promptMode ?? 'minimal',
    }

    const agentObs: AgentObservability = {
      metrics: this.metrics,
      usagePurpose: 'sub_agent',
      parentSessionId: ctx.sessionId,
      tracer: ctx.tracer,
      secretFilter: ctx.secretFilter,
      providerName: resolvedModel?.providerName,
      modelLabel: resolvedModelLabel,
      pricing: resolvedModel?.modelConfig.pricing,
      sessionEvents:
        sessionEvents && logFile
          ? {
              append: (_sessionId, events) => sessionEvents.append(agentId, events),
              appendMessage: (_sessionId, message) => sessionEvents.appendMessage(agentId, message),
              getLastSeq: () => sessionEvents.getLastSeq(agentId),
            }
          : undefined,
    }

    const agent = new Agent(agentConfig, adapter, scopedRegistry, toolContext, agentObs)
    const systemPrompt = buildSystemPrompt({
      agentName: agentLabel,
      agentDescription: resolvedAgentInstruction,
      tools: toolDefinitions,
      globalIdentity: '',
      agentIdentity: '',
      workspacePath: subWorkDir,
      projectRoot: ctx.projectRoot,
      promptMode: agentConfig.promptMode,
    })
    // 声明窗口后,长时间运行的子代理在 turn 内也按压力压缩
    const agentContext: AgentContext = {
      systemPrompt,
      conversationHistory: [],
      tools: toolDefinitions,
      maxContext: resolvedModel?.modelConfig.maxContext,
      maxOutput: resolvedModel?.modelConfig.maxOutput,
    }

    if (sessionEvents && logFile) {
      const toolNames = toolDefinitions.map((definition) => definition.name)
      const sha256 = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
      sessionEvents.append(agentId, [
        {
          type: 'system/prompt',
          data: { hash: sha256(systemPrompt), chars: systemPrompt.length, content: systemPrompt },
        },
        {
          type: 'tools/set',
          data: { hash: sha256(JSON.stringify(toolNames)), toolNames, count: toolNames.length },
        },
      ])
    }

    // Record the full system prompt in the sub_agent span for debugging/auditing
    if (subAgentSpan?.id && ctx.tracer) {
      const safeSystemPrompt = ctx.secretFilter
        ? ctx.secretFilter.filter(systemPrompt)
        : systemPrompt
      ctx.tracer.updateSpan(subAgentSpan.id, {
        data: { systemPrompt: safeSystemPrompt },
      })
    }

    const spawnResult = ctx.agentControl.spawn(agent, agentContext, trimmedInstruction, {
      mode,
      label: agentLabel,
      role: spawnedRole,
      model: resolvedModelLabel,
      depth: 1,
      traceSpanId: subAgentSpan?.id,
      tracer: ctx.tracer,
      logger: ctx.logger,
      secretFilter: ctx.secretFilter,
      sessionId: ctx.sessionId,
      agentId,
    })

    if ('error' in spawnResult) {
      if (subAgentSpan) {
        ctx.tracer?.updateSpan(subAgentSpan.id, {
          data: {
            success: false,
            error: spawnResult.error,
          },
        })
        ctx.tracer?.endSpan(subAgentSpan.id, 'error', {
          error: spawnResult.error,
        })
      }
      return {
        success: false,
        output: spawnResult.error,
        outputSummary: 'Sub-agent spawn failed',
      }
    }

    if (sessionEvents && logFile) {
      sessionEvents.append(ctx.sessionId, [
        {
          type: 'subagent/spawn',
          data: {
            childSessionId: agentId,
            name: agentLabel,
            role: spawnedRole,
            spawnedByRequestId: ctx.currentRequestId,
            logFile,
          },
        },
      ])
    }

    if (ctx.currentTraceSpanId) {
      ctx.tracer?.updateSpan(ctx.currentTraceSpanId, {
        data: {
          spawnedAgentId: spawnResult.agentId,
          spawnedAgentLabel: spawnResult.label,
          spawnedAgentModel: resolvedModelLabel,
          spawnedAgentSpanId: subAgentSpan?.id,
        },
        metadata: {
          spawnedAgentId: spawnResult.agentId,
          spawnedAgentLabel: spawnResult.label,
          spawnedAgentModel: resolvedModelLabel,
          spawnedAgentSpanId: subAgentSpan?.id,
        },
      })
    }

    return {
      success: true,
      output: JSON.stringify(
        {
          agent_id: spawnResult.agentId,
          label: spawnResult.label,
          mode: mode ?? 'standard',
          model: resolvedModelLabel,
        },
        null,
        2,
      ),
      outputSummary: `Spawned sub-agent "${spawnResult.label}"`,
    }
  }

  private buildScopedRegistry(
    toolNames?: string[],
    modelConfig?: { capabilities: string[] },
  ): ToolRegistry {
    const scopedRegistry = new ToolRegistry()
    const selectedNames =
      toolNames && toolNames.length > 0
        ? toolNames
        : this.baseToolRegistry
            .list()
            .map((tool) => tool.name)
            .filter((toolName) => !SUB_AGENT_BLOCKED_TOOLS.has(toolName))

    for (const toolName of selectedNames) {
      if (SUB_AGENT_BLOCKED_TOOLS.has(toolName)) continue
      const tool = this.baseToolRegistry.get(toolName)
      if (tool && supportsToolForModel(tool, modelConfig)) {
        scopedRegistry.register(tool)
      }
    }

    return scopedRegistry
  }

  private sanitizeSegment(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
  }
}
