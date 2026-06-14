import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { URL } from 'node:url'
import { buildAuthorizingOAuthAttemptStatus, buildOAuthAttemptErrorStatus } from './attempt'
import type { ManagedOAuthProvider } from './driver'
import type { ManagedOAuthStatus } from './status'

export const DEFAULT_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'

export interface ManagedOAuthCallbackConfig {
  redirectUri?: string
  listenHost?: string
  listenPort?: number
  callbackPath?: string
}

export interface ManagedOAuthCoordinatorOptions extends ManagedOAuthCallbackConfig {}

export interface ResolvedOAuthCallbackConfig {
  protocol: 'http:' | 'https:'
  listenHost: string
  listenPort: number
  callbackPath: string
}

export interface OAuthCallbackAttempt {
  id: string
  provider: ManagedOAuthProvider
  state: string
  callbackPath: string
}

export type OAuthCallbackRequestResult =
  | { kind: 'not_found'; statusCode: 404; body: string }
  | { kind: 'error'; statusCode: 400; body: string; status: ManagedOAuthStatus }
  | { kind: 'success'; statusCode: 200; code: string; status: ManagedOAuthStatus }

export function parseDefaultOAuthCallbackConfig(
  options: ManagedOAuthCoordinatorOptions,
): ResolvedOAuthCallbackConfig {
  const redirectUri = options.redirectUri ?? DEFAULT_OAUTH_REDIRECT_URI
  const parsed = new URL(redirectUri)

  return {
    protocol: parsed.protocol === 'https:' ? 'https:' : 'http:',
    listenHost: options.listenHost ?? parsed.hostname,
    listenPort:
      options.listenPort ?? Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
    callbackPath: options.callbackPath ?? parsed.pathname,
  }
}

export function resolveOAuthCallbackConfig(
  defaultCallbackConfig: ResolvedOAuthCallbackConfig,
  driverConfig?: ManagedOAuthCallbackConfig,
): ResolvedOAuthCallbackConfig {
  if (!driverConfig) {
    return defaultCallbackConfig
  }

  if (driverConfig.redirectUri) {
    const parsed = new URL(driverConfig.redirectUri)
    return {
      protocol: parsed.protocol === 'https:' ? 'https:' : 'http:',
      listenHost: driverConfig.listenHost ?? parsed.hostname,
      listenPort:
        driverConfig.listenPort ?? Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
      callbackPath: driverConfig.callbackPath ?? parsed.pathname,
    }
  }

  return {
    protocol: 'http:',
    listenHost: driverConfig.listenHost ?? defaultCallbackConfig.listenHost,
    listenPort: driverConfig.listenPort ?? defaultCallbackConfig.listenPort,
    callbackPath: driverConfig.callbackPath ?? defaultCallbackConfig.callbackPath,
  }
}

export function parseOAuthAuthorizationInput(rawInput: string): {
  code: string | null
  state: string | null
} {
  const trimmed = rawInput.trim()
  if (!trimmed) return { code: null, state: null }

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed)
    return {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
    }
  }

  return {
    code: trimmed,
    state: null,
  }
}

export function resolveOAuthCallbackRequest(options: {
  attempt: OAuthCallbackAttempt
  callbackConfig: ResolvedOAuthCallbackConfig
  requestPath: string
}): OAuthCallbackRequestResult {
  const { attempt, callbackConfig, requestPath } = options
  const requestUrl = new URL(
    requestPath,
    `${callbackConfig.protocol}//${callbackConfig.listenHost}`,
  )

  if (requestUrl.pathname !== attempt.callbackPath) {
    return { kind: 'not_found', statusCode: 404, body: 'Not found' }
  }

  const callbackState = requestUrl.searchParams.get('state')
  if (callbackState !== attempt.state) {
    return {
      kind: 'error',
      statusCode: 400,
      body: 'State mismatch',
      status: buildOAuthAttemptErrorStatus(attempt, 'State validation failed.'),
    }
  }

  const code = requestUrl.searchParams.get('code')
  if (!code) {
    return {
      kind: 'error',
      statusCode: 400,
      body: 'Missing code',
      status: buildOAuthAttemptErrorStatus(attempt, 'Missing authorization code.'),
    }
  }

  return {
    kind: 'success',
    statusCode: 200,
    code,
    status: buildAuthorizingOAuthAttemptStatus(attempt),
  }
}

export async function startManagedOAuthCallbackServer(options: {
  attempt: OAuthCallbackAttempt
  callbackConfig: ResolvedOAuthCallbackConfig
  getSuccessHtml(): string
  onStatus(status: ManagedOAuthStatus): void
  onCode(code: string): Promise<void>
}): Promise<{ server: Server; redirectUri: string }> {
  const { attempt, callbackConfig } = options

  return await new Promise<{ server: Server; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const result = resolveOAuthCallbackRequest({
        attempt,
        callbackConfig,
        requestPath: req.url ?? '/',
      })

      if (result.kind === 'not_found') {
        res.statusCode = result.statusCode
        res.end(result.body)
        return
      }

      options.onStatus(result.status)
      if (result.kind === 'error') {
        res.statusCode = result.statusCode
        res.end(result.body)
        return
      }

      res.statusCode = result.statusCode
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(options.getSuccessHtml())

      void options.onCode(result.code)
    })

    server.once('error', (error) => reject(error))
    server.listen(callbackConfig.listenPort, callbackConfig.listenHost, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve OAuth callback server address.')))
        return
      }

      const { port } = address as AddressInfo
      resolve({
        server,
        redirectUri: `${callbackConfig.protocol}//${callbackConfig.listenHost}:${port}${callbackConfig.callbackPath}`,
      })
    })
  })
}
