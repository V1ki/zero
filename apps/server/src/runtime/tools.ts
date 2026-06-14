import { join } from 'node:path'
import {
  BashTool,
  CloseAgentTool,
  CodexTool,
  EditTool,
  FetchTool,
  MemoryReadTool,
  MemorySearchTool,
  MemoryTool,
  ReadImageTool,
  ReadTool,
  ScheduleTool,
  SendInputTool,
  SpawnAgentTool,
  ToolRegistry,
  WaitAgentTool,
  WriteTool,
  XSearchTool,
  loadFuseList,
} from '@zero-os/core'
import { type ModelRouter, getXPremiumAuthorizationScheme } from '@zero-os/model'
import type { MetricsDB } from '@zero-os/observe'
import type { Vault } from '@zero-os/secrets'
import type { SystemConfig } from '@zero-os/shared'
import { getManagedOAuthKindForProvider } from '../providers/managed-oauth'
import { getXPremiumBaseUrl, XPremiumTokenManager } from '../providers/x-premium'

export interface RuntimeToolRegistryOptions {
  zeroDir: string
  config: SystemConfig
  vault: Vault
  modelRouter: ModelRouter
  metrics: MetricsDB
}

interface XSearchToolOptions {
  config: SystemConfig
  vault: Vault
}

interface XPremiumOAuthProvider {
  providerName: string
  tokenRef: string
}

export function createXSearchTool({ config, vault }: XSearchToolOptions): XSearchTool | null {
  const xPremiumOAuthProvider = findXPremiumOAuthProvider(config, vault)
  const hasXApiKey = Boolean(vault.get('xai_api_key')?.trim())
  if (!xPremiumOAuthProvider && !hasXApiKey) return null

  return new XSearchTool({
    credentialProvider: async () => {
      if (xPremiumOAuthProvider) {
        const session = await new XPremiumTokenManager(vault, {
          providerName: xPremiumOAuthProvider.providerName,
          tokenRef: xPremiumOAuthProvider.tokenRef,
        }).ensureFreshSession()
        return {
          bearerToken: session.accessToken,
          authorizationScheme: getXPremiumAuthorizationScheme(session.tokenType),
          baseUrl: getXPremiumBaseUrl(),
          source: 'x-premium-oauth',
        }
      }

      const apiKey = vault.get('xai_api_key')?.trim()
      if (!apiKey) return undefined
      return {
        bearerToken: apiKey,
        authorizationScheme: 'Bearer',
        baseUrl: getXPremiumBaseUrl(),
        source: 'xai-api-key',
      }
    },
  })
}

export function createRuntimeToolRegistry({
  zeroDir,
  config,
  vault,
  modelRouter,
  metrics,
}: RuntimeToolRegistryOptions): ToolRegistry {
  const fuseRules = loadFuseList(join(zeroDir, 'fuse_list.yaml'))
  const toolRegistry = new ToolRegistry()
  toolRegistry.register(new ReadTool())
  toolRegistry.register(new ReadImageTool())
  toolRegistry.register(new WriteTool())
  toolRegistry.register(new EditTool())
  toolRegistry.register(new BashTool(fuseRules))
  toolRegistry.register(new FetchTool())
  toolRegistry.register(new MemorySearchTool())
  toolRegistry.register(new MemoryReadTool())
  toolRegistry.register(new MemoryTool())
  toolRegistry.register(new ScheduleTool())
  toolRegistry.register(new CodexTool())

  const xSearchTool = createXSearchTool({ config, vault })
  if (xSearchTool) toolRegistry.register(xSearchTool)

  toolRegistry.register(new SpawnAgentTool(modelRouter, toolRegistry, metrics))
  toolRegistry.register(new WaitAgentTool())
  toolRegistry.register(new CloseAgentTool())
  toolRegistry.register(new SendInputTool())
  return toolRegistry
}

function findXPremiumOAuthProvider(
  config: SystemConfig,
  vault: Vault,
): XPremiumOAuthProvider | undefined {
  for (const [providerName, provider] of Object.entries(config.providers)) {
    const kind = getManagedOAuthKindForProvider(providerName, provider.auth.managedOAuthProvider)
    const tokenRef = provider.auth.oauthTokenRef
    if (kind === 'x-premium' && tokenRef && vault.get(tokenRef)?.trim()) {
      return { providerName, tokenRef }
    }
  }

  return undefined
}
