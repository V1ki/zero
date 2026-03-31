import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelRouter } from '@zero-os/model'
import type { MetricsDB } from '@zero-os/observe'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { toErrorMessage } from '@zero-os/shared'
import { Agent, type AgentConfig, type AgentContext, type AgentObservability } from '../agent/agent'
import { buildSubAgentPrompt } from '../agent/prompt'
import { type RoleDefinition, getBuiltinRoles, loadRoles, resolveRole } from '../agent/roles'
import { type TaskNode, TaskOrchestrator, type TaskResult } from '../task/orchestrator'
import { BaseTool } from './base'
import { SUB_AGENT_BLOCKED_TOOLS } from './constants'
import { ToolRegistry } from './registry'

interface SubAgentSpec {
  id: string
  instruction: string
  preset?: string
  name?: string
  agentInstruction?: string
  dependsOn?: string[]
  timeout?: number
  tools?: string[]
}

interface TaskInput {
  tasks: SubAgentSpec[]
}

export class TaskTool extends BaseTool {
  name = 'task'
  description =
    'Launch SubAgents to execute specific tasks. Supports preset agents (builtin and file-configured roles) and custom agents. Tasks can have dependencies for ordered execution.'
  parameters = {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique task ID for dependency references' },
            instruction: { type: 'string', description: 'What the SubAgent should do' },
            preset: {
              type: 'string',
              description:
                'Preset SubAgent type. Builtins include explorer, coder, reviewer; project roles from .zero/roles/* are also supported.',
            },
            name: { type: 'string', description: 'Custom agent name (required if no preset)' },
            agentInstruction: {
              type: 'string',
              description: 'Custom agent role instruction (required if no preset)',
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs of tasks this depends on',
            },
            timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names to give the SubAgent',
            },
          },
          required: ['id', 'instruction'],
        },
        description: 'Array of SubAgent tasks with optional dependencies',
      },
    },
    required: ['tasks'],
  }

  private modelRouter: ModelRouter
  private baseToolRegistry: ToolRegistry
  private orchestrator = new TaskOrchestrator()

  constructor(
    modelRouter: ModelRouter,
    baseToolRegistry: ToolRegistry,
    private metrics?: MetricsDB,
  ) {
    super()
    this.modelRouter = modelRouter
    this.baseToolRegistry = baseToolRegistry
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const { tasks } = input as TaskInput

    if (!tasks || tasks.length === 0) {
      return { success: false, output: 'No tasks provided', outputSummary: 'No tasks' }
    }

    const roles = ctx.projectRoot ? await loadRoles(ctx.projectRoot) : getBuiltinRoles()
    const rolesByTaskId = new Map<string, RoleDefinition | undefined>()

    // Validate and build TaskNodes
    const nodes: TaskNode[] = []
    for (const spec of tasks) {
      const resolved = this.resolveAgentConfig(spec, roles)
      if (!resolved) {
        return {
          success: false,
          output: `Task "${spec.id}": must specify either preset or both name and agentInstruction`,
          outputSummary: 'Invalid task config',
        }
      }
      rolesByTaskId.set(spec.id, resolved.role)

      nodes.push({
        id: spec.id,
        agentConfig: resolved.config,
        instruction: spec.instruction,
        dependsOn: spec.dependsOn ?? [],
        timeout: spec.timeout ?? 120_000,
      })
    }

    // Execute task graph
    const executor = async (
      node: TaskNode,
      upstreamResults: Map<string, TaskResult>,
    ): Promise<TaskResult> => {
      const startTime = Date.now()

      // Build instruction with upstream context
      let fullInstruction = node.instruction
      if (node.dependsOn.length > 0) {
        const upstreamContext = node.dependsOn
          .map((depId) => {
            const result = upstreamResults.get(depId)
            return result ? `## Output from task "${depId}":\n${result.output}` : ''
          })
          .filter(Boolean)
          .join('\n\n')

        if (upstreamContext) {
          fullInstruction = `${upstreamContext}\n\n---\n\n## Your task:\n${node.instruction}`
        }
      }

      // Find the matching spec to get tools list
      const spec = tasks.find((t) => t.id === node.id)
      const role = rolesByTaskId.get(node.id)
      const scopedRegistry = this.buildScopedRegistry(spec, role)

      // Create SubAgent with isolated workspace
      const resolvedModel = role?.model
        ? this.modelRouter.resolveModel(role.model)
        : ctx.currentModel
          ? this.modelRouter.resolveModel(ctx.currentModel)
          : this.modelRouter.getCurrentModel()
      const adapter = resolvedModel?.adapter ?? this.modelRouter.getAdapter()
      const subAgentName = spec?.name ?? role?.name ?? spec?.preset ?? node.id
      const subWorkDir = join(ctx.workDir, subAgentName)
      if (!existsSync(subWorkDir)) {
        mkdirSync(subWorkDir, { recursive: true })
      }
      const subAgentSpan = ctx.tracer?.startSpan(
        ctx.sessionId,
        `sub_agent:${subAgentName}`,
        ctx.currentTraceSpanId,
        {
          kind: 'sub_agent',
          agentName: subAgentName,
          data: {
            subAgentName,
            taskId: node.id,
            spawnedByRequestId: ctx.currentRequestId,
          },
        },
      )
      const toolContext: ToolContext = {
        ...ctx,
        sessionId: ctx.sessionId,
        workDir: subWorkDir,
        currentModel: resolvedModel
          ? this.modelRouter.getModelLabel(resolvedModel)
          : ctx.currentModel,
        currentRequestId: undefined,
        currentTraceSpanId: subAgentSpan?.id ?? ctx.currentTraceSpanId,
        spawnedByRequestId: ctx.currentRequestId,
        agentControl: undefined,
      }

      const agentObs: AgentObservability = {
        metrics: this.metrics,
        usagePurpose: 'sub_agent',
        parentSessionId: ctx.sessionId,
        tracer: ctx.tracer,
        secretFilter: ctx.secretFilter,
        providerName: resolvedModel?.providerName,
        modelLabel: resolvedModel
          ? this.modelRouter.getModelLabel(resolvedModel)
          : ctx.currentModel,
        pricing: resolvedModel?.modelConfig.pricing,
      }

      const agent = new Agent(node.agentConfig, adapter, scopedRegistry, toolContext, agentObs)

      // Build structured SubAgent prompt with upstream results
      const subAgentSystemPrompt = buildSubAgentPrompt(
        scopedRegistry.getDefinitions(),
        node.instruction,
        node.agentConfig.agentInstruction,
        upstreamResults as Map<string, { output: string; success: boolean }>,
        node.dependsOn,
      )

      const agentContext: AgentContext = {
        systemPrompt: subAgentSystemPrompt,
        conversationHistory: [],
        tools: scopedRegistry.getDefinitions(),
      }

      try {
        const messages = await agent.run(agentContext, fullInstruction)

        // Extract assistant text from the last message
        const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
        const output =
          lastAssistant?.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { type: 'text'; text: string }).text)
            .join('\n') ?? ''

        if (subAgentSpan) {
          ctx.tracer?.updateSpan(subAgentSpan.id, {
            data: {
              success: true,
              outputSummary: output.slice(0, 200),
            },
          })
          ctx.tracer?.endSpan(subAgentSpan.id, 'success')
        }

        return {
          nodeId: node.id,
          success: true,
          output,
          durationMs: Date.now() - startTime,
        }
      } catch (error) {
        const errorMessage = toErrorMessage(error)
        if (subAgentSpan) {
          ctx.tracer?.updateSpan(subAgentSpan.id, {
            data: {
              success: false,
              error: errorMessage,
            },
          })
          ctx.tracer?.endSpan(subAgentSpan.id, 'error', {
            error: errorMessage,
          })
        }
        throw error
      }
    }

    const results = await this.orchestrator.execute(nodes, executor)

    // Format output
    const outputParts: string[] = []
    let allSuccess = true
    for (const [id, result] of results) {
      const status = result.success ? 'SUCCESS' : 'FAILED'
      if (!result.success) allSuccess = false
      outputParts.push(`### Task "${id}" [${status}] (${result.durationMs}ms)\n${result.output}`)
    }

    const output = outputParts.join('\n\n---\n\n')
    const summary = allSuccess
      ? `All ${results.size} tasks completed successfully`
      : `${results.size} tasks completed with failures`

    return { success: allSuccess, output, outputSummary: summary }
  }

  private resolveAgentConfig(
    spec: SubAgentSpec,
    roles: Record<string, RoleDefinition>,
  ): { config: AgentConfig; role?: RoleDefinition } | null {
    if (spec.preset) {
      const role = resolveRole(spec.preset, roles)
      if (!role) return null
      return {
        config: {
          name: spec.name ?? role.name,
          agentInstruction: spec.agentInstruction ?? role.agentInstruction,
          promptMode: role.promptMode ?? 'minimal',
        },
        role,
      }
    }

    if (spec.name && spec.agentInstruction) {
      return {
        config: {
          name: spec.name,
          agentInstruction: spec.agentInstruction,
        },
      }
    }

    return null
  }

  private buildScopedRegistry(
    spec: SubAgentSpec | undefined,
    role: RoleDefinition | undefined,
  ): ToolRegistry {
    const scopedRegistry = new ToolRegistry()
    const requestedToolNames = spec?.tools ?? role?.defaultTools
    const toolNames = requestedToolNames ?? ['read', 'bash']

    for (const toolName of toolNames) {
      if (SUB_AGENT_BLOCKED_TOOLS.has(toolName)) continue

      const tool = this.baseToolRegistry.get(toolName)
      if (tool) {
        scopedRegistry.register(tool)
      }
    }

    return scopedRegistry
  }
}
