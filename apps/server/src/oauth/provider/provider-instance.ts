export interface OAuthProviderInstanceOptions {
  name?: string
  providerName?: string
  oauthTokenRef?: string
}

export interface OAuthProviderInstanceDefaults {
  providerName: string
  oauthTokenRef: string
  namedTokenRefPrefix: string
}

export interface OAuthProviderInstance {
  providerName: string
  oauthTokenRef: string
}

export function resolveOAuthProviderInstance(
  options: OAuthProviderInstanceOptions,
  defaults: OAuthProviderInstanceDefaults,
): OAuthProviderInstance {
  if (options.providerName || options.oauthTokenRef) {
    return {
      providerName: options.providerName ?? defaults.providerName,
      oauthTokenRef: options.oauthTokenRef ?? defaults.oauthTokenRef,
    }
  }

  if (!options.name) {
    return {
      providerName: defaults.providerName,
      oauthTokenRef: defaults.oauthTokenRef,
    }
  }

  const slug = toInstanceSlug(options.name)
  return {
    providerName: `${defaults.providerName}-${slug}`,
    oauthTokenRef: `${defaults.namedTokenRefPrefix}_${slug.replace(/-/g, '_')}`,
  }
}

function toInstanceSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) {
    throw new Error('OAuth provider instance name must contain at least one letter or number.')
  }
  return slug
}
