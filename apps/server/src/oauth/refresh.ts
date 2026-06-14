export interface OAuthRefreshErrorDetail {
  code?: string
  message?: string
}

export interface OAuthRefreshFailureErrorOptions {
  providerLabel: string
  status: number
  statusText?: string
  body: string
  reauthMessage: string
  reauthCodes: string[]
  includeReauthContext?: boolean
}

export function buildOAuthRefreshFailureError(options: OAuthRefreshFailureErrorOptions): Error {
  const detail = extractOAuthRefreshErrorDetail(options.body)
  if (
    isOAuthReauthRequiredRefreshFailure({
      status: options.status,
      detail,
      reauthCodes: options.reauthCodes,
    })
  ) {
    return new Error(
      options.includeReauthContext === false
        ? options.reauthMessage
        : buildOAuthReauthErrorMessage({
            baseMessage: options.reauthMessage,
            status: options.status,
            detail,
          }),
    )
  }

  const message = detail.message ?? options.body.trim() ?? options.statusText
  return new Error(
    `${options.providerLabel} OAuth token refresh failed: ${options.status} ${message ?? ''}`.trim(),
  )
}

export function extractOAuthRefreshErrorDetail(body: string): OAuthRefreshErrorDetail {
  if (!body.trim()) return {}

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const error = parsed.error
    if (typeof error === 'string') {
      return {
        code: error,
        message:
          typeof parsed.error_description === 'string'
            ? parsed.error_description
            : typeof parsed.message === 'string'
              ? parsed.message
              : error,
      }
    }

    if (error && typeof error === 'object') {
      const typedError = error as Record<string, unknown>
      return {
        code:
          typeof typedError.code === 'string'
            ? typedError.code
            : typeof parsed.code === 'string'
              ? parsed.code
              : undefined,
        message:
          typeof typedError.message === 'string'
            ? typedError.message
            : typeof parsed.error_description === 'string'
              ? parsed.error_description
              : typeof parsed.message === 'string'
                ? parsed.message
                : undefined,
      }
    }

    return {
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
      message:
        typeof parsed.error_description === 'string'
          ? parsed.error_description
          : typeof parsed.message === 'string'
            ? parsed.message
            : undefined,
    }
  } catch {
    return { message: body.trim() }
  }
}

function isOAuthReauthRequiredRefreshFailure(options: {
  status: number
  detail: OAuthRefreshErrorDetail
  reauthCodes: string[]
}): boolean {
  const normalizedCode = options.detail.code?.toLowerCase()
  return (
    options.status === 401 ||
    (typeof normalizedCode === 'string' && options.reauthCodes.includes(normalizedCode))
  )
}

function buildOAuthReauthErrorMessage(options: {
  baseMessage: string
  status: number
  detail: OAuthRefreshErrorDetail
}): string {
  const context: string[] = []
  if (options.status > 0) context.push(`status=${options.status}`)
  if (options.detail.code) {
    context.push(`code=${options.detail.code}`)
  } else if (options.detail.message) {
    const normalizedMessage = options.detail.message.trim().replace(/\s+/g, ' ')
    if (normalizedMessage) context.push(`reason=${normalizedMessage.slice(0, 120)}`)
  }

  return context.length > 0 ? `${options.baseMessage} [${context.join(', ')}]` : options.baseMessage
}
