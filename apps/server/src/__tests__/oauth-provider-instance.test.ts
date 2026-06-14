import { describe, expect, test } from 'bun:test'
import { resolveOAuthProviderInstance } from '../oauth/provider/provider-instance'

const defaults = {
  providerName: 'chatgpt',
  oauthTokenRef: 'chatgpt_oauth_token',
  namedTokenRefPrefix: 'chatgpt_oauth',
}

describe('resolveOAuthProviderInstance', () => {
  test('returns default and explicit provider instances', () => {
    expect(resolveOAuthProviderInstance({}, defaults)).toEqual({
      providerName: 'chatgpt',
      oauthTokenRef: 'chatgpt_oauth_token',
    })

    expect(
      resolveOAuthProviderInstance(
        {
          providerName: 'chatgpt-work',
          oauthTokenRef: 'chatgpt_oauth_work',
        },
        defaults,
      ),
    ).toEqual({
      providerName: 'chatgpt-work',
      oauthTokenRef: 'chatgpt_oauth_work',
    })
  })

  test('builds named instances with stable provider and token refs', () => {
    expect(resolveOAuthProviderInstance({ name: 'Work Account' }, defaults)).toEqual({
      providerName: 'chatgpt-work-account',
      oauthTokenRef: 'chatgpt_oauth_work_account',
    })
  })

  test('rejects empty named instances', () => {
    expect(() => resolveOAuthProviderInstance({ name: ' ... ' }, defaults)).toThrow(
      'OAuth provider instance name must contain at least one letter or number.',
    )
  })
})
