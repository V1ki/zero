import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '@zero-os/core'
import type { ProviderConfig, SystemConfig } from '@zero-os/shared'
import type { CliOptions, ModelTarget, SecretSource } from './types'

const DISABLE_MODEL_CONFIG_VALUES = new Set(['', 'none', 'false', 'off'])

export const DEFAULT_MODELS: ModelTarget[] = [
  {
    id: 'gpt-5-5',
    label: 'GPT-5.5',
    model: 'chatgpt/gpt-5.5',
  },
  {
    id: 'qwen-3-6-27b-local',
    label: 'Qwen 3.6 27B (4x GPU vLLM)',
    model: 'qwen-local/qwen3.6-27b',
  },
  {
    id: 'qwen-3-6-plus-token-plan',
    label: 'Qwen 3.6 Plus (Token Plan)',
    model: 'dashscope-token-plan/qwen3.6-plus',
  },
]

export function parseCliOptions(argv: string[]): CliOptions {
  const command = argv[0] === 'run' ? 'run' : 'plan'
  const args = argv.slice(1)
  const runId = getArg(args, 'run-id') ?? new Date().toISOString().replace(/[:.]/g, '-')
  const dataDir = getArg(args, 'data-dir') ?? join(process.cwd(), '.zero')
  const modelConfigPath = parseModelConfigPath(getArg(args, 'model-config'))

  return {
    command,
    cases: getListArg(args, 'cases'),
    configPath: getArg(args, 'config') ?? join(dataDir, 'config.yaml'),
    ...(modelConfigPath ? { modelConfigPath } : {}),
    dataDir,
    outDir: getArg(args, 'out') ?? join(dataDir, 'benchmarks', 'zero-runtime', 'runs', runId),
    models: parseModels(getArg(args, 'models')),
    runId,
    secretSource: parseSecretSource(getArg(args, 'secret-source')),
    timeoutMs: getNumberArg(args, 'timeout-ms'),
  }
}

export function defaultModelConfigPath(): string {
  return join(process.cwd(), 'benchmarks', 'zero-runtime', 'config', 'models.yaml')
}

export function loadBenchmarkConfig(options: Pick<CliOptions, 'configPath' | 'modelConfigPath'>) {
  const base = loadConfig(options.configPath)
  if (!options.modelConfigPath || !existsSync(options.modelConfigPath)) return base

  const overlay = loadConfig(options.modelConfigPath)
  return mergeBenchmarkConfig(base, overlay)
}

export function mergeBenchmarkConfig(base: SystemConfig, overlay: SystemConfig): SystemConfig {
  const providers: SystemConfig['providers'] = { ...base.providers }

  for (const [name, provider] of Object.entries(overlay.providers)) {
    providers[name] = mergeProviderConfig(providers[name], provider)
  }

  return {
    ...base,
    providers,
  }
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function parseModelConfigPath(raw: string | undefined): string | undefined {
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase()
    return DISABLE_MODEL_CONFIG_VALUES.has(normalized) ? undefined : raw
  }

  const path = defaultModelConfigPath()
  return existsSync(path) ? path : undefined
}

function parseModels(raw: string | undefined): ModelTarget[] {
  if (!raw) return DEFAULT_MODELS

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((entry) => {
      const [model, label] = entry.split('=').map((part) => part.trim())
      return {
        id: slugify(label || model),
        label: label || model,
        model,
      }
    })
}

function mergeProviderConfig(
  base: ProviderConfig | undefined,
  overlay: ProviderConfig,
): ProviderConfig {
  if (!base) return overlay

  return {
    apiType: overlay.apiType ?? base.apiType,
    baseUrl: overlay.baseUrl || base.baseUrl,
    auth: {
      ...base.auth,
      ...overlay.auth,
    },
    models: {
      ...base.models,
      ...overlay.models,
    },
  }
}

function parseSecretSource(raw: string | undefined): SecretSource {
  return raw === 'vault' ? 'vault' : 'env'
}

function getArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  if (index < 0) return undefined
  return args[index + 1]
}

function getListArg(args: string[], name: string): string[] {
  const value = getArg(args, name)
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}

function getNumberArg(args: string[], name: string): number | undefined {
  const value = getArg(args, name)
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}
