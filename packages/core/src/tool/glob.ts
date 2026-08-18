import { statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { BaseTool } from './base'

const DEFAULT_MAX_RESULTS = 100
const MAX_RESULTS_LIMIT = 500
const SCAN_MATCH_CAP = 5_000
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.git', 'dist'])

interface GlobInput {
  pattern: string
  path?: string
  includeHidden?: boolean
  maxResults?: number
}

export class GlobTool extends BaseTool {
  kind = 'built-in' as const
  name = 'glob'
  description =
    'Find files by glob pattern, sorted by modification time (newest first). Results are capped, node_modules/.git/dist are skipped. Patterns not starting with "**/" search recursively (e.g. "*.ts" becomes "**/*.ts"). Prefer this over find/ls through bash.'
  parameters = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files, e.g. "*.ts" or "src/**/*.test.ts"',
      },
      path: {
        type: 'string',
        description: 'Base directory to search from. Defaults to the session workspace.',
      },
      includeHidden: {
        type: 'boolean',
        description: 'Also match dotfiles and dot-directories (default false)',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum files to return (default 100, max 500)',
      },
    },
    required: ['pattern'],
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const globInput = input as GlobInput
    const rawPattern = globInput.pattern
    if (typeof rawPattern !== 'string' || !rawPattern.trim()) {
      return { success: false, output: 'Pattern cannot be empty', outputSummary: 'Empty pattern' }
    }

    const pattern = normalizePattern(rawPattern.trim())
    const maxResults = clampMaxResults(globInput.maxResults)
    const baseDir = globInput.path
      ? isAbsolute(globInput.path)
        ? globInput.path
        : resolve(ctx.workDir, globInput.path)
      : ctx.workDir

    const glob = new Bun.Glob(pattern)
    const matches: Array<{ path: string; mtimeMs: number }> = []
    let scanCapped = false

    for await (const relativePath of glob.scan({
      cwd: baseDir,
      onlyFiles: true,
      dot: globInput.includeHidden ?? false,
    })) {
      if (hasExcludedSegment(relativePath)) continue

      let mtimeMs = 0
      try {
        mtimeMs = statSync(join(baseDir, relativePath)).mtimeMs
      } catch {
        continue
      }
      matches.push({ path: relativePath, mtimeMs })

      if (matches.length >= SCAN_MATCH_CAP) {
        scanCapped = true
        break
      }
    }

    if (matches.length === 0) {
      return {
        success: true,
        output: `No files matched "${pattern}" under ${baseDir}`,
        outputSummary: 'No files matched',
      }
    }

    matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const shown = matches.slice(0, maxResults)

    let output = shown.map((match) => match.path).join('\n')
    if (matches.length > shown.length) {
      output += `\n\n[... ${matches.length - shown.length} more matched files omitted; narrow the pattern or raise maxResults ...]`
    }
    if (scanCapped) {
      output += `\n[scan stopped after ${SCAN_MATCH_CAP} matches; results may be incomplete]`
    }

    return {
      success: true,
      output,
      outputSummary: `Found ${matches.length}${scanCapped ? '+' : ''} files, showing ${shown.length}`,
    }
  }
}

function normalizePattern(pattern: string): string {
  if (pattern.startsWith('**/') || pattern.startsWith('/')) return pattern
  return `**/${pattern}`
}

function clampMaxResults(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS
  return Math.max(1, Math.min(MAX_RESULTS_LIMIT, Math.floor(value)))
}

function hasExcludedSegment(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment))
}
