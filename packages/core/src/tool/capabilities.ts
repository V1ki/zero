import type { ModelConfig } from '@zero-os/shared'
import type { BaseTool } from './base'

export function supportsToolForModel(
  tool: BaseTool,
  modelConfig?: Pick<ModelConfig, 'capabilities'>,
): boolean {
  const required = tool.requiredModelCapabilities
  if (required.length === 0) return true
  const modelCapabilities = new Set(modelConfig?.capabilities ?? [])
  return required.every((capability) => modelCapabilities.has(capability))
}

export function supportsVision(modelConfig?: Pick<ModelConfig, 'capabilities'>): boolean {
  return Boolean(modelConfig?.capabilities.includes('vision'))
}
