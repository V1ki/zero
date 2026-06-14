import type { Vault } from '@zero-os/secrets'
import type { ManagedOAuthDriver } from '../driver'
import type { ManagedOAuthSessionStatusDetails, ManagedOAuthStatus } from '../status'
import type { OAuthDriverSession } from './driver-session'

interface ManagedOAuthDriverBaseOptions<Session> {
  providerName: string
  callbackSuccessLabel: string
  session: OAuthDriverSession<Session>
}

export abstract class ManagedOAuthDriverBase<Session> implements ManagedOAuthDriver<Session> {
  readonly provider: string
  private readonly callbackSuccessLabel: string
  private readonly session: OAuthDriverSession<Session>

  protected constructor(options: ManagedOAuthDriverBaseOptions<Session>) {
    this.provider = options.providerName
    this.callbackSuccessLabel = options.callbackSuccessLabel
    this.session = options.session
  }

  abstract buildAuthorizationUrl(params: {
    state: string
    redirectUri: string
    codeVerifier: string
    codeChallenge: string
  }): string | Promise<string>

  abstract exchangeCode(params: {
    code: string
    state: string
    redirectUri: string
    codeVerifier: string
  }): Promise<Session>

  abstract buildConnectedStatus(
    session: Session,
    options: { attemptId?: string; requiresRestart: boolean },
  ): ManagedOAuthStatus

  readSession(vault: Vault): Session | null {
    return this.session.read(vault, this.session.tokenRef)
  }

  writeSession(vault: Vault, session: Session): void {
    vault.set(this.session.tokenRef, this.session.serialize(session))
  }

  async refreshStatus(vault: Vault, options: { force?: boolean } = {}): Promise<void> {
    const refresher = this.session.createSessionRefresher(vault)
    if (options.force) {
      await refresher.refreshSession('unauthorized')
      return
    }

    await refresher.ensureFreshSession()
  }

  getCallbackSuccessHtml(): string {
    return `<html><body><h2>ZeRo OS</h2><p>${this.callbackSuccessLabel} authorization received. You can return to ZeRo OS.</p></body></html>`
  }

  protected buildConnectedOAuthStatus(
    session: Session,
    options: { attemptId?: string; requiresRestart: boolean },
    details: ManagedOAuthSessionStatusDetails = {},
  ): ManagedOAuthStatus {
    const expired = this.session.isExpiring(session)
    return {
      provider: this.provider,
      state: expired ? 'expired' : 'connected',
      authorized: !expired,
      ...details,
      attemptId: options.attemptId,
      requiresRestart: options.requiresRestart,
    }
  }
}
