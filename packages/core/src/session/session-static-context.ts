import { hostname } from 'node:os'
import { join } from 'node:path'
import type { ModelRouter, ResolvedModel } from '@zero-os/model'
import type { ChannelCapabilities, Session as SessionData, ToolDefinition } from '@zero-os/shared'
import type { AgentConfig } from '../agent/agent'
import { buildSystemPrompt } from '../agent/prompt'
import { loadBootstrapFiles } from '../bootstrap/loader'
import { loadSkills } from '../skill'
import { supportsToolForModel } from '../tool/capabilities'
import type { ToolRegistry } from '../tool/registry'
import type { SessionDeps } from './session-types'

export interface SessionStaticContext {
  currentModel: ResolvedModel | undefined
  tools: ToolDefinition[]
  toolNames: string[]
  systemPrompt: string
  projectRoot: string
  workspacePath: string
}

export interface SessionStaticContextProviderOptions {
  data: SessionData
  modelRouter: ModelRouter
  toolRegistry: ToolRegistry
  deps: SessionDeps
  getAgentConfig: () => AgentConfig | null
  getActiveModel: () => ResolvedModel | undefined
  getChannelCapabilities: () => ChannelCapabilities | undefined
}

export class SessionStaticContextProvider {
  private cachedSystemPrompt: string | null = null
  private cachedToolNames: string[] = []
  private knownSkillNames = new Set<string>()
  private lastSystemPrompt = ''

  constructor(private readonly options: SessionStaticContextProviderOptions) {}

  invalidatePrompt(): void {
    this.cachedSystemPrompt = null
  }

  resetForAgentConfig(): void {
    this.cachedSystemPrompt = null
    this.cachedToolNames = []
    this.knownSkillNames.clear()
  }

  setLastSystemPrompt(systemPrompt: string): void {
    this.lastSystemPrompt = systemPrompt
  }

  getLastSystemPrompt(): string {
    return this.lastSystemPrompt
  }

  getCachedToolNames(): string[] {
    return [...this.cachedToolNames]
  }

  ensure(): SessionStaticContext {
    const currentModel = this.options.getActiveModel()
    const tools = this.getToolDefinitionsForModel(currentModel)
    const toolNames = tools.map((tool) => tool.name)
    const agentConfig = this.options.getAgentConfig()
    const agentName = agentConfig?.name ?? 'zero'
    const projectRoot = this.options.deps.projectRoot ?? process.cwd()
    const workspacePath = join(projectRoot, '.zero', 'workspace', agentName)

    if (
      !this.cachedSystemPrompt ||
      !SessionStaticContextProvider.sameStringArray(toolNames, this.cachedToolNames)
    ) {
      const identity = this.options.deps.identityReader?.(agentName)
      const globalIdentity = identity?.global ?? this.options.deps.globalIdentity ?? ''
      const agentIdentity = identity?.agent ?? this.options.deps.agentIdentity ?? ''
      const promptMode = agentConfig?.promptMode ?? 'full'

      const globalSkills = loadSkills(join(projectRoot, '.zero', 'skills'))
      const workspaceSkills = loadSkills(join(workspacePath, 'skills'))
      const skills = [...globalSkills, ...workspaceSkills]
      const bootstrapFiles = loadBootstrapFiles(workspacePath, promptMode)

      const runtimeInfo = {
        agentId: agentName,
        sessionId: this.options.data.id,
        host: hostname(),
        os: `${process.platform} (${process.arch})`,
        model: currentModel ? this.options.modelRouter.getModelLabel(currentModel) : undefined,
        shell: process.env.SHELL ?? 'zsh',
        channel: this.options.data.source,
        projectRoot,
        channelCapabilities: this.options.getChannelCapabilities(),
      }

      this.cachedSystemPrompt = buildSystemPrompt({
        agentName,
        agentDescription:
          agentConfig?.agentInstruction || '擅长 TypeScript 全栈开发，使用 Bun 运行时。',
        tools,
        skills,
        globalIdentity,
        agentIdentity,
        workspacePath,
        projectRoot,
        promptMode,
        bootstrapFiles,
        runtimeInfo,
      })
      this.cachedToolNames = [...toolNames]

      for (const skill of skills) this.knownSkillNames.add(skill.name)
    }

    const systemPrompt = this.cachedSystemPrompt
    this.lastSystemPrompt = systemPrompt

    return {
      currentModel,
      tools,
      toolNames,
      systemPrompt,
      projectRoot,
      workspacePath,
    }
  }

  loadNewSkills(projectRoot: string, workspacePath: string) {
    const globalSkills = loadSkills(join(projectRoot, '.zero', 'skills'))
    const workspaceSkills = loadSkills(join(workspacePath, 'skills'))
    const allSkills = [...globalSkills, ...workspaceSkills]
    const nextSkills = allSkills.filter((skill) => !this.knownSkillNames.has(skill.name))
    for (const skill of nextSkills) this.knownSkillNames.add(skill.name)
    return nextSkills
  }

  private getToolDefinitionsForModel(model?: ResolvedModel): ToolDefinition[] {
    return this.options.toolRegistry
      .list()
      .filter((tool) => supportsToolForModel(tool, model?.modelConfig))
      .map((tool) => tool.toDefinition())
  }

  private static sameStringArray(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }
}
