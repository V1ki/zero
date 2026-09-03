import { createHash } from 'node:crypto'

// Hardcoded on purpose: if the production service/account ever changes, this
// canary must break loudly instead of silently following a renamed constant.
const PRODUCTION_SERVICE = 'com.zero-os.vault'
const PRODUCTION_ACCOUNT = 'master-key'

/**
 * Incident canary (docs/effect-pilot.md, 2026-09-03): snapshot the production
 * master-key entry before a suite and verify it is unchanged after.
 *
 * Only a sha256 digest and the `security` exit code are ever compared — the
 * key value itself is never printed, logged, or persisted.
 */
async function readProductionEntryDigest(): Promise<string | null> {
  const proc = Bun.spawn(
    ['security', 'find-generic-password', '-s', PRODUCTION_SERVICE, '-a', PRODUCTION_ACCOUNT, '-w'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const exitCode = await proc.exited
  if (exitCode !== 0) return null
  const value = await new Response(proc.stdout).text()
  return createHash('sha256').update(value.trim()).digest('hex')
}

export function snapshotProductionMasterKey(): Promise<string | null> {
  return readProductionEntryDigest()
}

export async function expectProductionMasterKeyUnchanged(before: string | null): Promise<void> {
  const after = await readProductionEntryDigest()
  if (after === before) return
  throw new Error(
    `Production master-key entry changed during this test run (digest before: ${before ?? '<absent>'}, after: ${after ?? '<absent>'}). This is the incident class recorded in docs/effect-pilot.md: restore access by exporting the backed-up key via ZERO_MASTER_KEY_BASE64, then re-run \`bun zero init\` if needed.`,
  )
}
