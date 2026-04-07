import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TestProjectRoot {
  projectRoot: string
  zeroDir: string
  cleanup: () => void
}

export function createTestProjectRoot(prefix = 'zero-test-project-'): TestProjectRoot {
  const projectRoot = mkdtempSync(join(tmpdir(), prefix))
  const zeroDir = join(projectRoot, '.zero')

  mkdirSync(zeroDir, { recursive: true })

  return {
    projectRoot,
    zeroDir,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  }
}
