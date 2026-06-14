import type { Vault } from '@zero-os/secrets'
import type { ManagedOAuthProviderKind } from '@zero-os/shared'
import type { ManagedOAuthCallbackConfig } from './callback'
import type { ManagedOAuthStatus } from './status'

export type ManagedOAuthProvider = string

export interface ManagedOAuthDriver<Session = unknown> {
  readonly provider: ManagedOAuthProvider
  readonly kind?: ManagedOAuthProviderKind
  getCallbackConfig?(): ManagedOAuthCallbackConfig
  buildAuthorizationUrl(params: {
    state: string
    redirectUri: string
    codeVerifier: string
    codeChallenge: string
  }): string | Promise<string>
  exchangeCode(params: {
    code: string
    state: string
    redirectUri: string
    codeVerifier: string
  }): Promise<Session>
  readSession(vault: Vault): Session | null
  writeSession(vault: Vault, session: Session): void
  buildConnectedStatus(
    session: Session,
    options: {
      attemptId?: string
      requiresRestart: boolean
    },
  ): ManagedOAuthStatus
  refreshStatus?(vault: Vault, options?: { force?: boolean }): Promise<void>
  getCallbackSuccessHtml?(): string
}
