import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentCase, ClosureCase } from './cases'

type RealSuite = {
  schema: 1
  agent: AgentCase[]
  closure: ClosureCase[]
  provenance: unknown
}

export function readRealSuite(manifestPath: string): RealSuite {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    file: string
    sha256: string
  }
  const raw = readFileSync(resolve(manifestPath, '..', manifest.file), 'utf8')
  if (createHash('sha256').update(raw).digest('hex') !== manifest.sha256)
    throw new Error('Frozen real-task inputs changed; do not reuse the old comparison snapshots')
  const suite = JSON.parse(raw) as RealSuite
  if (suite.schema !== 1 || !Array.isArray(suite.agent) || !Array.isArray(suite.closure))
    throw new Error('Invalid real-task suite')
  return suite
}

export function getRealSuite() {
  return readRealSuite(
    resolve(import.meta.dir, '../../fixtures/prompt-bench/real-replay-v1.manifest.json'),
  )
}
