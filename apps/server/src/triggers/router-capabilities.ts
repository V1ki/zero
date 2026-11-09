import type { ToolDefinition } from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'

export interface RouterCapability {
  definition: ToolDefinition
  effect?: boolean
  execute(input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> | unknown
}

/** Adapters expose capabilities. The main loop never classifies prose to choose a tool. */
export function routerCapabilities(
  capabilities: RouterCapability[],
  onToolStep?: (name: string, ok: boolean) => void,
) {
  const registry = new Map(
    capabilities.map((capability) => [capability.definition.name, capability]),
  )
  if (registry.size !== capabilities.length) throw Error('Duplicate Router capability')
  const effects = new Map<string, Promise<unknown>>()
  return {
    definitions: capabilities.map((capability) => capability.definition),
    onToolStep,
    async execute(name: string, input: Record<string, unknown>, signal: AbortSignal) {
      signal.throwIfAborted()
      const capability = registry.get(name)
      if (!capability) throw new TriggerAgentError('当前授权没有提供此工具。')
      if (!capability.effect) return JSON.stringify(await capability.execute(input, signal))
      const key = JSON.stringify([
        name,
        Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
      ])
      let pending = effects.get(key)
      if (!pending) {
        pending = Promise.resolve().then(() => capability.execute(input, signal))
        effects.set(key, pending)
      }
      return JSON.stringify(await pending)
    },
  }
}

export function routerText(value: unknown, max: number | null = 8192): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    (max !== null && value.length > max) ||
    /\p{Cc}/u.test(value.replace(/[\t\r\n]/g, ''))
  )
    throw new TriggerAgentError(
      max === null ? '请输入有效文字。' : `请输入 1 至 ${max} 字的有效文字。`,
    )
  return value.trim()
}
export function routerInteger(value: unknown, fallback?: number): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < 1)
    throw new TriggerAgentError('需要正整数编号。')
  return resolved
}
export function routerChoice<T extends string>(value: unknown, choices: readonly T[]): T {
  const result = choices.find((choice) => choice === value)
  if (!result) throw new TriggerAgentError('请选择工具支持的选项。')
  return result
}
export function capability(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  execute: RouterCapability['execute'],
  optional: string[] = [],
  effect = false,
): RouterCapability {
  const required = Object.keys(properties).filter((key) => !optional.includes(key))
  return {
    effect,
    definition: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
    execute(input, signal) {
      if (
        Object.keys(input).some((key) => !Object.hasOwn(properties, key)) ||
        required.some((key) => !Object.hasOwn(input, key))
      )
        throw new TriggerAgentError('工具参数缺失或包含不支持的字段。')
      return execute(input, signal)
    },
  }
}
