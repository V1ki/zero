import { describe, expect, test } from 'bun:test'
import { ClaudeOAuthDriver } from '../providers/claude/oauth'

describe('ClaudeOAuthDriver', () => {
  test('buildAuthorizationUrl matches the current Claude Code authorize flow', () => {
    const driver = new ClaudeOAuthDriver()

    const url = new URL(
      driver.buildAuthorizationUrl({
        state: 'state-123',
        redirectUri: 'http://localhost:61293/callback',
        codeVerifier: 'verifier-123',
        codeChallenge: 'challenge-123',
      }),
    )

    expect(`${url.origin}${url.pathname}`).toBe('https://claude.ai/oauth/authorize')
    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:61293/callback')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-123')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('state-123')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'org:create_api_key',
      'user:profile',
      'user:inference',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
    ])
  })
})
