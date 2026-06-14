import type { Vault } from '@zero-os/secrets'
import type { OAuthRefreshReason } from './token-manager'

export interface OAuthSessionRefresher {
  ensureFreshSession(): Promise<unknown>
  refreshSession(reason: OAuthRefreshReason): Promise<unknown>
}

export interface OAuthDriverSession<Session> {
  tokenRef: string
  read(vault: Vault, tokenRef: string): Session | null
  serialize(session: Session): string
  isExpiring(session: Session): boolean
  createSessionRefresher(vault: Vault): OAuthSessionRefresher
}

interface OAuthDriverSessionOptions<Session> {
  providerName: string
  tokenRef: string
  readSession(vault: Vault, tokenRef: string): Session | null
  serializeSession(session: Session): string
  isSessionExpiring(session: Session): boolean
  createSessionRefresher(
    vault: Vault,
    context: { providerName: string; tokenRef: string },
  ): OAuthSessionRefresher
}

export function createOAuthDriverSession<Session>({
  providerName,
  tokenRef,
  readSession,
  serializeSession,
  isSessionExpiring,
  createSessionRefresher,
}: OAuthDriverSessionOptions<Session>): OAuthDriverSession<Session> {
  return {
    tokenRef,
    read: readSession,
    serialize: serializeSession,
    isExpiring: isSessionExpiring,
    createSessionRefresher: (vault) => createSessionRefresher(vault, { providerName, tokenRef }),
  }
}
