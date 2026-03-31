import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelRouter } from '@zero-os/model'
import type { MetricsDB } from '@zero-os/observe'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { generateId } from '@zero-os/shared'
import { Agent, type AgentConfig, type AgentContext, type AgentObservability } from '../agent/agent'
import { buildSubAgentPrompt } from '../agent/prompt'
import { loadRoles, resolveRole } from '../agent/roles'
import { BaseTool } from './base'
import { SUB_AGENT_BLOCKED_TOOLS } from './constants'
import { ToolRegistry } from './registry'

interface SpawnAgentInput {
  instruction: string
  label?: string
  mode?: 'standard' | 'interactive'
  role?: string
  agent_type?: string
  preset?: string
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
        description:
          'Optional role ID alias for agent_type/preset. For backward compatibility, if no matching role exists and no agentInstruction is provided, this value is used as the agent instruction.',
      },
      agent_type: {
        type: 'string',
        description: 'Optional role ID to use for the sub-agent.',
      },
      preset: {
        type: 'string',
        description: 'Backward-compatible alias for agent_type.',
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
  ) {
    super()

    const models = this.modelRouter.getRegistry().listModels()
    const modelLabels = models.map((model) => `${model.providerName}/${model.modelName}`)
    if (modelLabels.length > 0) {
      this.parameters.properties.model.description = `Optional model override for this sub-agent. Defaults to the current session model. Available: ${modelLabels.join(', ')}`
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

    const { instruction, label, mode, role, agent_type, preset, agentInstruction, tools, model } =
      input as SpawnAgentInput
    const trimmedInstruction = instruction.trim()
    const roles = await loadRoles(ctx.projectRoot ?? process.cwd())
    const requestedRoleId = preset?.trim() || agent_type?.trim() || role?.trim()
    const roleDefinition = requestedRoleId ? resolveRole(requestedRoleId, roles) : undefined
    const legacyRoleInstruction =
      !preset?.trim() && !agent_type?.trim() && requestedRoleId && !roleDefinition
        ? requestedRoleId
        : undefined

    if ((preset?.trim() || agent_type?.trim()) && requestedRoleId && !roleDefinition) {
      return {
        success: false,
        output: `Unknown sub-agent role: ${requestedRoleId}`,
        outputSummary: 'Unknown sub-agent role',
      }
    }

    const resolvedAgentInstruction =
      agentInstruction?.trim() ||
      roleDefinition?.agentInstruction ||
      legacyRoleInstruction ||
      'You are a focused sub-agent. Execute the assigned task and report back.'
    const agentLabel =
      label?.trim() ||
      roleDefinition?.name ||
      (legacyRoleInstruction ? role?.trim() : undefined) ||
      'SubAgent'

    const requestedModel = model?.trim() || roleDefinition?.model
    const resolvedModel = requestedModel
      ? this.modelRouter.resolveModel(requestedModel)
      : ctx.currentModel
        ? this.modelRouter.resolveModel(ctx.currentModel)
        : this.modelRouter.getCurrentModel()
    const adapter = resolvedModel?.adapter ?? this.modelRouter.getAdapter()
    const scopedRegistry = this.buildScopedRegistry(tools ?? roleDefinition?.defaultTools)
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
          instruction: safeInstructionSummary,
          spawnedByRequestId: ctx.currentRequestId,
        },
      },
    )

    const toolContext: ToolContext = {
      ...ctx,
      sessionId: ctx.sessionId,
      currentRequestId: undefined,
      currentModel: resolvedModel
        ? this.modelRouter.getModelLabel(resolvedModel)
        : ctx.currentModel,
      currentTraceSpanId: subAgentSpan?.id ?? ctx.currentTraceSpanId,
      spawnedByRequestId: ctx.currentRequestId,
      workDir: subWorkDir,
      agentControl: undefined,
    }

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
      modelLabel: resolvedModel ? this.modelRouter.getModelLabel(resolvedModel) : ctx.currentModel,
      pricing: resolvedModel?.modelConfig.pricing,
    }

    const agent = new Agent(agentConfig, adapter, scopedRegistry, toolContext, agentObs)
    const systemPrompt = buildSubAgentPrompt(
      toolDefinitions,
      trimmedInstruction,
      resolvedAgentInstruction,
    )
    const agentContext: AgentContext = {
      systemPrompt,
      conversationHistory: [],
      tools: toolDefinitions,
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
      role: roleDefinition ? requestedRoleId : undefined,
      depth: 1,
      traceSpanId: subAgentSpan?.id,
      tracer: ctx.tracer,
      logger: ctx.logger,
      secretFilter: ctx.secretFilter,
      sessionId: ctx.sessionId,
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

    if (ctx.currentTraceSpanId) {
      ctx.tracer?.updateSpan(ctx.currentTraceSpanId, {
        data: {
          spawnedAgentId: spawnResult.agentId,
          spawnedAgentLabel: spawnResult.label,
          spawnedAgentSpanId: subAgentSpan?.id,
        },
        metadata: {
          spawnedAgentId: spawnResult.agentId,
          spawnedAgentLabel: spawnResult.label,
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
        },
        null,
        2,
      ),
      outputSummary: `Spawned sub-agent "${spawnResult.label}"`,
    }
  }

  private buildScopedRegistry(toolNames?: string[]): ToolRegistry {
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
      if (tool) {
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
