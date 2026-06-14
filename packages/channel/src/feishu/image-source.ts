/**
 * Normalize a `file://` URI to a local filesystem path.
 * e.g. `file:///Users/foo/bar.png` -> `/Users/foo/bar.png`
 * Non-file references are returned unchanged.
 */
export function normalizeFeishuImageReference(reference: string): string {
  const trimmed = reference.trim()
  if (!trimmed.startsWith('file://')) return trimmed

  try {
    return new URL(trimmed).pathname
  } catch {
    return trimmed.replace(/^file:\/\//, '')
  }
}

export async function readFeishuImageReferenceBuffer(
  reference: string,
  timeoutMs = 15_000,
): Promise<Buffer> {
  const normalizedRef = normalizeFeishuImageReference(reference)

  if (normalizedRef.startsWith('http://') || normalizedRef.startsWith('https://')) {
    const resp = await fetch(normalizedRef, { signal: AbortSignal.timeout(timeoutMs) })
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`)
    }
    return Buffer.from(await resp.arrayBuffer())
  }

  if (normalizedRef.startsWith('data:')) {
    const match = normalizedRef.match(/^data:[^;,]+;base64,([\s\S]+)$/)
    if (!match) {
      throw new Error('Unsupported inline image data URI')
    }
    return Buffer.from(match[1].replace(/\s/g, ''), 'base64')
  }

  const fs = await import('node:fs')
  if (!fs.existsSync(normalizedRef)) {
    throw new Error(`File not found: ${normalizedRef}`)
  }
  return fs.readFileSync(normalizedRef)
}
