import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Vault } from '@zero-os/secrets'
import { createVaultGithubAppAuth } from '../github-app-auth'

test('opens only the isolated GitHub App vault on demand and retries a failed open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-app-vault-'))
  const key = randomBytes(32)
  const opens: string[] = []
  const ref = 'github_app_fixture'
  try {
    const path = join(dir, 'github-app', 'credentials.enc')
    mkdirSync(dirname(path), { mode: 0o700 })
    const general = new Vault(key, join(dir, 'secrets.enc'))
    general.set('github_listener_project', 'ordinary-pat')
    const dedicated = new Vault(key, path)
    dedicated.set(
      ref,
      JSON.stringify({
        appId: 147,
        privateKey: 'fixture',
        slug: 'fixture',
        repository: 'owner/project',
      }),
    )
    expect(general.get(ref)).toBeUndefined()
    expect(dedicated.get('github_listener_project')).toBeUndefined()
    const auth = createVaultGithubAppAuth(dir, async (filename) => {
      opens.push(filename)
      if (opens.length === 1) throw new Error('private filesystem detail')
      const vault = new Vault(key, filename)
      vault.load()
      return vault
    })
    const signal = new AbortController().signal
    expect(opens).toEqual([])
    await expect(auth.getToken(ref, 'owner/project', signal)).rejects.toThrow('专用凭据库')
    await expect(auth.getToken(ref, 'other/project', signal)).rejects.toThrow('未授权该仓库')
    await expect(auth.getToken(ref, 'owner/project', signal)).rejects.toThrow('私钥签名')
    expect(opens).toEqual([path, path])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
