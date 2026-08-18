import { createHash, randomBytes } from 'node:crypto'
import { URLSearchParams } from 'node:url'
import {
  type XPremiumOAuthAccount,
  type XPremiumOAuthSession,
  decodeXPremiumAccount,
  decodeXPremiumTokenExpiry,
  getXPremiumAuthorizationScheme,
  parseXPremiumOAuthSession,
  serializeXPremiumOAuthSession,
} from '@zero-os/model'
import type { Vault } from '@zero-os/secrets'
import type { SystemConfig } from '@zero-os/shared'
import { ManagedOAuthDriverBase } from '../oauth/provider/driver-base'
import { createOAuthDriverSession } from '../oauth/provider/driver-session'
import { ensureOAuthProviderConfig } from '../oauth/provider/provider-config'
import {
  type OAuthProviderInstanceOptions,
  resolveOAuthProviderInstance,
} from '../oauth/provider/provider-instance'
import { type OAuthRefreshReason, OAuthTokenManagerBase } from '../oauth/provider/token-manager'
import { buildOAuthRefreshFailureError } from '../oauth/refresh'
import type { ManagedOAuthStatus } from '../oauth/status'

const X_PREMIUM_PROVIDER = 'x-premium'
const X_PREMIUM_OAUTH_SESSION_REF = 'x_premium_oauth_session'
const X_PREMIUM_BASE_URL = 'https://api.x.ai/v1'
const xPremiumRefreshesByVault = new WeakMap<Vault, Map<string, Promise<XPremiumOAuthSession>>>()

export type XPremiumProviderInstanceOptions = OAuthProviderInstanceOptions

export function resolveXPremiumProviderInstance(options: XPremiumProviderInstanceOptions = {}) {
  return resolveOAuthProviderInstance(options, {
    providerName: X_PREMIUM_PROVIDER,
    oauthTokenRef: X_PREMIUM_OAUTH_SESSION_REF,
    namedTokenRefPrefix: 'x_premium_oauth',
  })
}

export function getXPremiumOAuthSessionRef() {
  return X_PREMIUM_OAUTH_SESSION_REF
}

export function getXPremiumProviderName() {
  return X_PREMIUM_PROVIDER
}

export function getXPremiumProviderLabel() {
  return 'X Premium'
}

export function getXPremiumBaseUrl() {
  return X_PREMIUM_BASE_URL
}

export function ensureXPremiumProviderConfig(options: XPremiumProviderInstanceOptions = {}): {
  changed: boolean
  config: SystemConfig
  providerName: string
  oauthTokenRef: string
} {
  const instance = resolveXPremiumProviderInstance(options)
  return ensureOAuthProviderConfig({
    instance,
    managedProviderName: X_PREMIUM_PROVIDER,
    apiType: 'x_responses',
    baseUrl: X_PREMIUM_BASE_URL,
    applyModels: ({ provider }) => ensureXPremiumDefaultModels(provider),
  })
}

function getDefaultXPremiumModels() {
  return {
    'grok-4.3': {
      model_id: 'grok-4.3',
      max_context: 256000,
      max_output: 8192,
      capabilities: ['tools', 'reasoning', 'vision'],
      tags: ['grok', 'x', 'premium', 'oauth'],
    },
    'grok-4.20-reasoning': {
      model_id: 'grok-4.20-reasoning',
      max_context: 256000,
      max_output: 8192,
      capabilities: ['tools', 'reasoning', 'vision'],
      tags: ['grok', 'x', 'premium', 'oauth'],
    },
  }
}

function ensureXPremiumDefaultModels(provider: Record<string, unknown>): boolean {
  const defaults = getDefaultXPremiumModels()
  if (!provider.models || typeof provider.models !== 'object') {
    provider.models = defaults
    return true
  }

  const models = provider.models as Record<string, unknown>
  let changed = false
  for (const [modelName, model] of Object.entries(defaults)) {
    if (!models[modelName]) {
      models[modelName] = model
      changed = true
    }
  }
  return changed
}

export const XAI_OAUTH_ISSUER = 'https://auth.x.ai'
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const XAI_OAUTH_SCOPE = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access',
]
export const XAI_REDIRECT_HOST = '127.0.0.1'
export const XAI_REDIRECT_PORT = 56121
export const XAI_REDIRECT_PATH = '/callback'
export const X_PREMIUM_OAUTH_REQUEST_TIMEOUT_MS = 15_000
export const X_PREMIUM_PREEMPTIVE_REFRESH_WINDOW_MS = 2 * 60_000
export const X_PREMIUM_MIN_VALIDITY_MS = 60_000
export const X_PREMIUM_REAUTH_MESSAGE =
  'X Premium OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login x-premium`.'
export const X_PREMIUM_TIER_DENIED_MESSAGE =
  'This X Premium OAuth account is not authorized for xAI API access. xAI may restrict API/OAuth access by plan tier; re-authentication usually will not change this. Use XAI_API_KEY with an API-key provider if available, or check the subscription at https://x.ai/grok.'

interface XPremiumDiscovery {
  authorizationEndpoint: string
  tokenEndpoint: string
}

export interface XPremiumOAuthInstanceOptions {
  providerName?: string
  tokenRef?: string
  requestTimeoutMs?: number
}

interface XPremiumAuthorizationUrlParams {
  state: string
  redirectUri: string
  codeChallenge: string
}

export interface XPremiumCodeExchangeRequestParams {
  code: string
  redirectUri: string
  codeVerifier: string
}

export type ExchangeXPremiumCodeParams = XPremiumCodeExchangeRequestParams

export interface XPremiumTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  id_token?: string
}

type XPremiumRefreshReason = OAuthRefreshReason

export class XPremiumOAuthDriver extends ManagedOAuthDriverBase<XPremiumOAuthSession> {
  readonly kind = 'x-premium' as const
  private requestTimeoutMs: number

  constructor(options: XPremiumOAuthInstanceOptions = {}) {
    const providerName = options.providerName ?? 'x-premium'
    const tokenRef = options.tokenRef ?? getXPremiumOAuthSessionRef()
    const requestTimeoutMs = options.requestTimeoutMs ?? X_PREMIUM_OAUTH_REQUEST_TIMEOUT_MS

    super({
      providerName,
      callbackSuccessLabel: 'X Premium',
      session: createOAuthDriverSession({
        providerName,
        tokenRef,
        readSession: readXPremiumSessionFromVault,
        serializeSession: serializeXPremiumOAuthSession,
        isSessionExpiring: isXPremiumSessionExpiring,
        createSessionRefresher: (vault, context) =>
          new XPremiumTokenManager(vault, {
            ...context,
            requestTimeoutMs,
          }),
      }),
    })
    this.requestTimeoutMs = requestTimeoutMs
  }

  getCallbackConfig() {
    return {
      listenHost: XAI_REDIRECT_HOST,
      listenPort: XAI_REDIRECT_PORT,
      callbackPath: XAI_REDIRECT_PATH,
    }
  }

  async buildAuthorizationUrl(params: {
    state: string
    redirectUri: string
    codeVerifier: string
    codeChallenge: string
  }): Promise<string> {
    return await buildXPremiumAuthorizationUrl(params, this.requestTimeoutMs)
  }

  async exchangeCode(params: {
    code: string
    state: string
    redirectUri: string
    codeVerifier: string
  }): Promise<XPremiumOAuthSession> {
    return await exchangeXPremiumCode(params, this.requestTimeoutMs)
  }

  buildConnectedStatus(
    session: XPremiumOAuthSession,
    options: { attemptId?: string; requiresRestart: boolean },
  ): ManagedOAuthStatus {
    return this.buildConnectedOAuthStatus(session, options, {
      expiresAt: session.expiresAt,
      accountId: session.account?.subject,
      accountEmail: session.account?.emailAddress,
      displayName: session.account?.displayName ?? session.account?.username,
    })
  }
}

export class XPremiumTokenManager extends OAuthTokenManagerBase<
  XPremiumOAuthSession,
  XPremiumRefreshReason
> {
  private requestTimeoutMs: number
  private readonly refreshes: Map<string, Promise<XPremiumOAuthSession>>
  private readonly tokenRef: string

  constructor(vault: Vault, options: XPremiumOAuthInstanceOptions = {}) {
    const providerName = options.providerName ?? 'x-premium'
    const tokenRef = options.tokenRef ?? getXPremiumOAuthSessionRef()
    const requestTimeoutMs = options.requestTimeoutMs ?? X_PREMIUM_OAUTH_REQUEST_TIMEOUT_MS
    super({
      providerLabel: 'X Premium',
      providerName,
      loginCommand: 'bun zero provider login x-premium',
      preemptiveRefreshWindowMs: X_PREMIUM_PREEMPTIVE_REFRESH_WINDOW_MS,
      minValidityMs: X_PREMIUM_MIN_VALIDITY_MS,
      reauthMessage: X_PREMIUM_REAUTH_MESSAGE,
      readSession: () => readXPremiumSessionFromVault(vault, tokenRef),
      persistSession: (session) => vault.set(tokenRef, serializeXPremiumOAuthSession(session)),
      isSessionExpiring: (session, minValidityMs) =>
        isXPremiumSessionExpiring(session, minValidityMs),
    })
    this.requestTimeoutMs = requestTimeoutMs
    this.refreshes = getXPremiumRefreshes(vault)
    this.tokenRef = tokenRef
  }

  async refreshSession(reason: XPremiumRefreshReason): Promise<XPremiumOAuthSession> {
    const existing = this.refreshes.get(this.tokenRef)
    if (existing) return existing

    const refresh = super.refreshSession(reason).finally(() => {
      if (this.refreshes.get(this.tokenRef) === refresh) {
        this.refreshes.delete(this.tokenRef)
      }
    })
    this.refreshes.set(this.tokenRef, refresh)
    return refresh
  }

  protected async performRefresh(
    currentSession: XPremiumOAuthSession,
    _reason: XPremiumRefreshReason,
  ): Promise<XPremiumOAuthSession> {
    return await refreshXPremiumSession(currentSession, this.requestTimeoutMs)
  }
}

function getXPremiumRefreshes(vault: Vault): Map<string, Promise<XPremiumOAuthSession>> {
  const existing = xPremiumRefreshesByVault.get(vault)
  if (existing) return existing

  const refreshes = new Map<string, Promise<XPremiumOAuthSession>>()
  xPremiumRefreshesByVault.set(vault, refreshes)
  return refreshes
}

export function readXPremiumSessionFromVault(
  vault: Vault,
  tokenRef = getXPremiumOAuthSessionRef(),
): XPremiumOAuthSession | null {
  return parseXPremiumOAuthSession(vault.get(tokenRef))
}

export function isXPremiumSessionExpiring(
  session: XPremiumOAuthSession,
  minValidityMs = X_PREMIUM_MIN_VALIDITY_MS,
): boolean {
  return Date.now() >= session.expiresAt - minValidityMs
}

export async function buildXPremiumAuthorizationUrl(
  params: XPremiumAuthorizationUrlParams,
  requestTimeoutMs: number,
): Promise<string> {
  const discovery = await discoverXPremiumOAuth(requestTimeoutMs)
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: params.redirectUri,
    scope: XAI_OAUTH_SCOPE.join(' '),
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    state: params.state,
    nonce: randomBytes(16).toString('hex'),
    plan: 'generic',
    referrer: 'zero-os',
  })

  return `${discovery.authorizationEndpoint}?${query.toString()}`
}

export async function exchangeXPremiumCode(
  params: ExchangeXPremiumCodeParams,
  requestTimeoutMs: number,
): Promise<XPremiumOAuthSession> {
  const discovery = await discoverXPremiumOAuth(requestTimeoutMs)

  const response = await requestXPremiumCodeExchange({
    tokenEndpoint: discovery.tokenEndpoint,
    params,
    requestTimeoutMs,
  })

  if (!response.ok) {
    await throwXPremiumCodeExchangeFailure(response, requestTimeoutMs)
  }

  return buildXPremiumSession(
    (await readXPremiumResponseJson(
      response,
      'token exchange response body read',
      requestTimeoutMs,
    )) as XPremiumTokenResponse,
    discovery.tokenEndpoint,
  )
}

export async function refreshXPremiumSession(
  currentSession: XPremiumOAuthSession,
  requestTimeoutMs: number,
): Promise<XPremiumOAuthSession> {
  const tokenEndpoint =
    currentSession.tokenEndpoint ?? (await discoverXPremiumOAuth(requestTimeoutMs)).tokenEndpoint
  validateXPremiumOAuthEndpoint(tokenEndpoint, 'token_endpoint')

  const response = await requestXPremiumTokenRefresh({
    tokenEndpoint,
    refreshToken: currentSession.refreshToken,
    requestTimeoutMs,
  })

  if (!response.ok) {
    await throwXPremiumRefreshFailure(response, requestTimeoutMs)
  }

  return buildXPremiumSession(
    (await readXPremiumResponseJson(
      response,
      'token refresh response body read',
      requestTimeoutMs,
    )) as XPremiumTokenResponse,
    tokenEndpoint,
    currentSession.refreshToken,
    currentSession,
  )
}

async function requestXPremiumCodeExchange(options: {
  tokenEndpoint: string
  params: XPremiumCodeExchangeRequestParams
  requestTimeoutMs: number
}): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.params.code,
    redirect_uri: options.params.redirectUri,
    client_id: XAI_OAUTH_CLIENT_ID,
    code_verifier: options.params.codeVerifier,
    code_challenge: buildXPremiumCodeChallenge(options.params.codeVerifier),
    code_challenge_method: 'S256',
  })

  return await withXPremiumTimeout('token exchange request', options.requestTimeoutMs, (signal) =>
    fetch(options.tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal,
    }),
  )
}

async function requestXPremiumTokenRefresh(options: {
  tokenEndpoint: string
  refreshToken: string
  requestTimeoutMs: number
}): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: options.refreshToken,
  })

  return await withXPremiumTimeout('token refresh request', options.requestTimeoutMs, (signal) =>
    fetch(options.tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal,
    }),
  )
}

async function throwXPremiumCodeExchangeFailure(
  response: Response,
  requestTimeoutMs: number,
): Promise<never> {
  const body = await readXPremiumResponseText(
    response,
    'token exchange error body read',
    requestTimeoutMs,
  )

  if (response.status === 403) {
    throw buildXPremiumTierDeniedError('xAI token exchange failed with HTTP 403', body)
  }

  throw new Error(`xAI token exchange failed: ${response.status} ${body}`)
}

async function throwXPremiumRefreshFailure(
  response: Response,
  requestTimeoutMs: number,
): Promise<never> {
  const body = await readXPremiumResponseText(
    response,
    'token refresh error body read',
    requestTimeoutMs,
  )

  if (response.status === 403) {
    throw buildXPremiumTierDeniedError('xAI token refresh failed with HTTP 403', body)
  }

  throw buildOAuthRefreshFailureError({
    providerLabel: 'X Premium',
    status: response.status,
    statusText: response.statusText,
    body,
    reauthMessage: X_PREMIUM_REAUTH_MESSAGE,
    reauthCodes: ['invalid_grant', 'invalid_token'],
  })
}

function buildXPremiumTierDeniedError(prefix: string, body: string): Error {
  const detail = body.trim()
  return new Error(
    `${prefix}.${detail ? ` Response: ${detail}.` : ''} ${X_PREMIUM_TIER_DENIED_MESSAGE}`,
  )
}

export function buildXPremiumSession(
  data: XPremiumTokenResponse,
  tokenEndpoint: string,
  fallbackRefreshToken?: string,
  fallbackSession?: XPremiumOAuthSession,
): XPremiumOAuthSession {
  if (!data.access_token) {
    throw new Error('X Premium OAuth token response missing access_token.')
  }

  const refreshToken = data.refresh_token ?? fallbackRefreshToken
  if (!refreshToken) {
    throw new Error('X Premium OAuth token response missing refresh_token.')
  }

  const expiresAt = resolveXPremiumSessionExpiry(data.access_token, data.expires_in)
  if (!expiresAt) {
    throw new Error('Failed to determine X Premium OAuth token expiry.')
  }

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt,
    tokenType: getXPremiumAuthorizationScheme(
      data.token_type ?? fallbackSession?.tokenType ?? 'Bearer',
    ),
    scopes: parseXPremiumSessionScopes(data.scope),
    idToken: data.id_token ?? fallbackSession?.idToken,
    tokenEndpoint,
    account: resolveXPremiumSessionAccount(data, fallbackSession),
  }
}

function resolveXPremiumSessionExpiry(
  accessToken: string,
  expiresInSeconds: number | undefined,
): number | null {
  if (typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds)) {
    return Date.now() + expiresInSeconds * 1000
  }

  return decodeXPremiumTokenExpiry(accessToken)
}

function parseXPremiumSessionScopes(scope: string | undefined): string[] {
  return scope?.split(' ').filter(Boolean) ?? XAI_OAUTH_SCOPE
}

function resolveXPremiumSessionAccount(
  data: XPremiumTokenResponse,
  fallbackSession?: XPremiumOAuthSession,
): XPremiumOAuthAccount | undefined {
  return (
    firstUsableAccount(decodeXPremiumAccount(data.id_token)) ??
    firstUsableAccount(decodeXPremiumAccount(data.access_token)) ??
    fallbackSession?.account
  )
}

function firstUsableAccount(
  account: XPremiumOAuthAccount | undefined,
): XPremiumOAuthAccount | undefined {
  if (!account) return undefined
  return account.subject || account.emailAddress || account.displayName || account.username
    ? account
    : undefined
}

function buildXPremiumCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}

async function discoverXPremiumOAuth(
  timeoutMs = X_PREMIUM_OAUTH_REQUEST_TIMEOUT_MS,
): Promise<XPremiumDiscovery> {
  const response = await withXPremiumTimeout('OIDC discovery request', timeoutMs, (signal) =>
    fetch(XAI_OAUTH_DISCOVERY_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal,
    }),
  )

  if (!response.ok) {
    const body = await readXPremiumResponseText(
      response,
      'OIDC discovery error body read',
      timeoutMs,
    )
    throw new Error(`xAI OIDC discovery failed: ${response.status} ${body}`)
  }

  const payload = (await readXPremiumResponseJson(
    response,
    'OIDC discovery response body read',
    timeoutMs,
  )) as Record<string, unknown>
  const authorizationEndpoint =
    typeof payload.authorization_endpoint === 'string' ? payload.authorization_endpoint.trim() : ''
  const tokenEndpoint =
    typeof payload.token_endpoint === 'string' ? payload.token_endpoint.trim() : ''

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error('xAI OIDC discovery response was missing required endpoints.')
  }

  validateXPremiumOAuthEndpoint(authorizationEndpoint, 'authorization_endpoint')
  validateXPremiumOAuthEndpoint(tokenEndpoint, 'token_endpoint')

  return {
    authorizationEndpoint,
    tokenEndpoint,
  }
}

function validateXPremiumOAuthEndpoint(url: string, field: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') {
    throw new Error(`xAI OIDC discovery returned a non-HTTPS ${field}: ${url}`)
  }

  const host = parsed.hostname.toLowerCase()
  if (host !== 'x.ai' && !host.endsWith('.x.ai')) {
    throw new Error(`xAI OIDC discovery ${field} host "${host}" is not on the xAI origin.`)
  }
}

async function withXPremiumTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(buildTimeoutError(label, timeoutMs))
    }, timeoutMs)
  })

  try {
    return await Promise.race([operation(controller.signal), timeout])
  } catch (error) {
    if (timedOut) throw buildTimeoutError(label, timeoutMs)
    throw error
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function readXPremiumResponseText(
  response: Response,
  label: string,
  timeoutMs: number,
): Promise<string> {
  return await withXPremiumTimeout(label, timeoutMs, () => response.text())
}

async function readXPremiumResponseJson(
  response: Response,
  label: string,
  timeoutMs: number,
): Promise<unknown> {
  return await withXPremiumTimeout(label, timeoutMs, () => response.json())
}

function buildTimeoutError(label: string, timeoutMs: number): Error {
  return new Error(`X Premium OAuth ${label} timed out after ${timeoutMs}ms.`)
}
