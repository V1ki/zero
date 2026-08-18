import { apiFetch } from '../lib/api'
import { getOAuthKind } from './config-shared'
import type { ProviderView } from './config-shared'

interface OAuthStatusView {
  state: string
  authorized: boolean
  error?: string
  requiresRestart: boolean
}

export type OAuthProviderStatusPatch = Pick<
  ProviderView,
  'authorized' | 'oauthState' | 'oauthError' | 'requiresRestart'
>

type OAuthStatusFetcher = (providerName: string) => Promise<OAuthStatusView>

const defaultOAuthStatusFetcher: OAuthStatusFetcher = async (providerName) =>
  await apiFetch<OAuthStatusView>(
    `/api/providers/${encodeURIComponent(providerName)}/oauth/status?refresh=soft`,
  )

export async function refreshExpiredOAuthProviders(
  providers: Record<string, ProviderView>,
  fetchStatus: OAuthStatusFetcher = defaultOAuthStatusFetcher,
): Promise<Record<string, OAuthProviderStatusPatch>> {
  const expiredProviders = Object.entries(providers).filter(([name, provider]) => {
    return provider.oauthState === 'expired' && Boolean(getOAuthKind(name, provider))
  })

  const refreshed = await Promise.all(
    expiredProviders.map(async ([name]) => {
      try {
        const status = await fetchStatus(name)
        return [
          name,
          {
            authorized: status.authorized,
            oauthState: status.state,
            oauthError: status.error,
            requiresRestart: status.requiresRestart,
          },
        ] as const
      } catch {
        return null
      }
    }),
  )

  return Object.fromEntries(refreshed.filter((entry) => entry !== null))
}
