export type OAuthRefreshReason = 'expiring' | 'unauthorized'

interface OAuthTokenManagerConfig<Session> {
  providerLabel: string
  providerName: string
  loginCommand: string
  preemptiveRefreshWindowMs: number
  minValidityMs: number
  reauthMessage: string
  readSession(): Session | null
  persistSession(session: Session): void
  isSessionExpiring(session: Session, minValidityMs: number): boolean
}

export abstract class OAuthTokenManagerBase<
  Session,
  Reason extends OAuthRefreshReason = OAuthRefreshReason,
> {
  private refreshPromise: Promise<Session> | null = null

  protected constructor(private readonly config: OAuthTokenManagerConfig<Session>) {}

  readSession(): Session | null {
    return this.config.readSession()
  }

  async ensureFreshSession(options: { minValidityMs?: number } = {}): Promise<Session> {
    const session = this.requireSession()
    const minValidityMs = options.minValidityMs ?? this.config.preemptiveRefreshWindowMs
    if (!this.config.isSessionExpiring(session, minValidityMs)) {
      return session
    }

    return this.refreshSession('expiring' as Reason)
  }

  async refreshSession(reason: Reason): Promise<Session> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    const currentSession = this.requireSession()
    const refreshPromise = this.refreshAndPersist(currentSession, reason).finally(() => {
      if (this.refreshPromise === refreshPromise) {
        this.refreshPromise = null
      }
    })

    this.refreshPromise = refreshPromise
    return refreshPromise
  }

  protected abstract performRefresh(currentSession: Session, reason: Reason): Promise<Session>

  protected get reauthMessage(): string {
    return this.config.reauthMessage
  }

  private requireSession(): Session {
    const session = this.readSession()
    if (session) return session

    throw new Error(
      `${this.config.providerLabel} OAuth credentials not found for ${this.config.providerName}. Please run \`${this.config.loginCommand}\`.`,
    )
  }

  private async refreshAndPersist(currentSession: Session, reason: Reason): Promise<Session> {
    const refreshedSession = await this.performRefresh(currentSession, reason)

    if (this.config.isSessionExpiring(refreshedSession, this.config.minValidityMs)) {
      throw new Error(this.config.reauthMessage)
    }

    this.config.persistSession(refreshedSession)
    return refreshedSession
  }
}
