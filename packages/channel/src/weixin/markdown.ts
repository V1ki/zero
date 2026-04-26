/**
 * Convert generic markdown into Weixin-friendly chat bubbles.
 *
 * Rules (mirrored from Hermes):
 *   - `# Title`        → `【Title】`
 *   - `## Title` etc.  → `**Title**`
 *   - `[text](url)`    → `text (url)`
 *   - GitHub-style tables → `- key: value` lists
 *   - Preserve fenced code blocks as single units
 */

import { MAX_MESSAGE_LENGTH } from './constants'

const HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/
const TABLE_RULE_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/
const FENCE_RE = /^```([^\n`]*)\s*$/
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g

function rewriteHeader(line: string): string {
  const match = line.match(HEADER_RE)
  if (!match) return line.trimEnd()
  const level = match[1].length
  const title = match[2].trim()
  return level === 1 ? `【${title}】` : `**${title}**`
}

function splitTableRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|')) row = row.slice(0, -1)
  return row.split('|').map((cell) => cell.trim())
}

function rewriteTableBlock(lines: string[]): string {
  if (lines.length < 2) return lines.join('\n')
  const headers = splitTableRow(lines[0])
  const bodyRows = lines.slice(2).filter((l) => l.trim().length > 0).map(splitTableRow)
  if (headers.length === 0 || bodyRows.length === 0) return lines.join('\n')

  const formatted: string[] = []
  for (const row of bodyRows) {
    const pairs: Array<[string, string]> = []
    headers.forEach((header, idx) => {
      if (idx >= row.length) return
      const value = row[idx].trim()
      if (value) pairs.push([header || `Column ${idx + 1}`, value])
    })
    if (pairs.length === 0) continue
    if (pairs.length === 1) {
      formatted.push(`- ${pairs[0][0]}: ${pairs[0][1]}`)
    } else if (pairs.length === 2) {
      formatted.push(`- ${pairs[0][0]}: ${pairs[0][1]}`)
      formatted.push(`  ${pairs[1][0]}: ${pairs[1][1]}`)
    } else {
      formatted.push(`- ${pairs.map(([k, v]) => `${k}: ${v}`).join(' | ')}`)
    }
  }
  return formatted.length > 0 ? formatted.join('\n') : lines.join('\n')
}

export function normalizeMarkdownForWeixin(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, '')
    if (FENCE_RE.test(line.trim())) {
      inCodeBlock = !inCodeBlock
      result.push(line)
      i += 1
      continue
    }
    if (inCodeBlock) {
      result.push(line)
      i += 1
      continue
    }
    if (
      i + 1 < lines.length &&
      lines[i].includes('|') &&
      TABLE_RULE_RE.test(lines[i + 1].replace(/\s+$/, ''))
    ) {
      const tableLines = [lines[i].replace(/\s+$/, ''), lines[i + 1].replace(/\s+$/, '')]
      i += 2
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i].replace(/\s+$/, ''))
        i += 1
      }
      result.push(rewriteTableBlock(tableLines))
      continue
    }
    const rewritten = rewriteHeader(line).replace(MARKDOWN_LINK_RE, '$1 ($2)')
    result.push(rewritten)
    i += 1
  }
  const normalized = result.map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n')
  return normalized.trim()
}

function splitMarkdownBlocks(content: string): string[] {
  if (!content) return []
  const blocks: string[] = []
  const lines = content.split('\n')
  let current: string[] = []
  let inCodeBlock = false
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')
    if (FENCE_RE.test(line.trim())) {
      if (!inCodeBlock && current.length > 0) {
        blocks.push(current.join('\n').trim())
        current = []
      }
      current.push(line)
      inCodeBlock = !inCodeBlock
      if (!inCodeBlock) {
        blocks.push(current.join('\n').trim())
        current = []
      }
      continue
    }
    if (inCodeBlock) {
      current.push(line)
      continue
    }
    if (!line.trim()) {
      if (current.length > 0) {
        blocks.push(current.join('\n').trim())
        current = []
      }
      continue
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current.join('\n').trim())
  return blocks.filter(Boolean)
}

function truncateHard(content: string, maxLength: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < content.length; i += maxLength) {
    chunks.push(content.slice(i, i + maxLength))
  }
  return chunks
}

function packBlocks(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content]
  const packed: string[] = []
  let current = ''
  for (const block of splitMarkdownBlocks(content)) {
    const candidate = current ? `${current}\n\n${block}` : block
    if (candidate.length <= maxLength) {
      current = candidate
      continue
    }
    if (current) {
      packed.push(current)
      current = ''
    }
    if (block.length <= maxLength) {
      current = block
    } else {
      packed.push(...truncateHard(block, maxLength))
    }
  }
  if (current) packed.push(current)
  return packed
}

function splitDeliveryUnits(content: string): string[] {
  const units: string[] = []
  for (const block of splitMarkdownBlocks(content)) {
    const firstLine = block.split('\n')[0].trim()
    if (FENCE_RE.test(firstLine)) {
      units.push(block)
      continue
    }
    let current: string[] = []
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\s+$/, '')
      if (!line.trim()) {
        if (current.length > 0) {
          units.push(current.join('\n').trim())
          current = []
        }
        continue
      }
      const isContinuation = current.length > 0 && /^[\s\t]/.test(rawLine)
      if (isContinuation) {
        current.push(line)
        continue
      }
      if (current.length > 0) units.push(current.join('\n').trim())
      current = [line]
    }
    if (current.length > 0) units.push(current.join('\n').trim())
  }
  return units.filter(Boolean)
}

function looksLikeChattyLine(line: string): boolean {
  const stripped = line.trim()
  if (!stripped) return false
  if (stripped.length > 48) return false
  if (/^[\s\t]/.test(line)) return false
  if (/^[>\-*【]/.test(stripped)) return false
  if (/^\*\*[^*]+\*\*$/.test(stripped)) return false
  if (/^\d+\.\s/.test(stripped)) return false
  return true
}

function looksLikeHeadingLine(line: string): boolean {
  const stripped = line.trim()
  if (!stripped) return false
  return stripped.length <= 24 && /[:：]$/.test(stripped)
}

function shouldSplitShortChatBlock(block: string): boolean {
  const lines = block.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 2 || lines.length > 6) return false
  if (looksLikeHeadingLine(lines[0])) return false
  return lines.every(looksLikeChattyLine)
}

export interface SplitOptions {
  maxLength?: number
  splitMultilineMessages?: boolean
}

export function splitForWeixinDelivery(content: string, options: SplitOptions = {}): string[] {
  const maxLength = options.maxLength ?? MAX_MESSAGE_LENGTH
  if (!content) return []
  if (options.splitMultilineMessages) {
    if (content.length <= maxLength && !content.includes('\n')) return [content]
    const chunks: string[] = []
    for (const unit of splitDeliveryUnits(content)) {
      if (unit.length <= maxLength) chunks.push(unit)
      else chunks.push(...packBlocks(unit, maxLength))
    }
    const filtered = chunks.filter(Boolean)
    return filtered.length > 0 ? filtered : [content]
  }
  if (content.length <= maxLength) {
    if (shouldSplitShortChatBlock(content)) {
      return splitDeliveryUnits(content).filter(Boolean)
    }
    return [content]
  }
  const packed = packBlocks(content, maxLength)
  return packed.length > 0 ? packed : [content]
}
