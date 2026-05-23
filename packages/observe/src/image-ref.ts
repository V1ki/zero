import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ImageRef, getSessionLogRelativeDir } from '@zero-os/shared'

interface ExternalizeImageDataOptions {
  logsBasePath?: string
  sessionId: string
}

const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/

export function externalizeImageData<T>(value: T, options: ExternalizeImageDataOptions): T {
  if (!options.logsBasePath) return value
  return externalizeValue(value, options) as T
}

function externalizeValue(
  value: unknown,
  options: ExternalizeImageDataOptions,
  key?: string,
): unknown {
  if (typeof value === 'string') {
    if (key === 'url' || key === 'image_url') {
      return externalizeDataUrl(value, options) ?? value
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => externalizeValue(item, options))
  }

  if (!isRecord(value)) return value

  const imageLike = externalizeImageRecord(value, options)
  if (imageLike) return imageLike

  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, nestedValue]) => [
      nestedKey,
      externalizeValue(nestedValue, options, nestedKey),
    ]),
  )
}

function externalizeImageRecord(
  record: Record<string, unknown>,
  options: ExternalizeImageDataOptions,
): Record<string, unknown> | undefined {
  const mediaType = getImageMediaType(record)
  if (!mediaType) return undefined

  const data = typeof record.data === 'string' ? record.data : undefined
  if (!data) {
    if (record.imageRef) {
      const { data: _data, ...withoutData } = record
      return withoutData
    }
    return undefined
  }

  const ref = writeImageRef(data, mediaType, options)
  const { data: _data, ...withoutData } = record
  return {
    ...withoutData,
    imageRef: ref,
  }
}

function externalizeDataUrl(
  value: string,
  options: ExternalizeImageDataOptions,
): { imageRef: ImageRef } | undefined {
  const parsed = parseImageData(value)
  if (!parsed) return undefined
  return { imageRef: writeImageRef(parsed.data, parsed.mediaType, options) }
}

function writeImageRef(
  data: string,
  fallbackMediaType: string,
  options: ExternalizeImageDataOptions,
): ImageRef {
  const parsed = parseImageData(data)
  const mediaType = normalizeImageMediaType(parsed?.mediaType ?? fallbackMediaType)
  const base64 = parsed?.data ?? data
  const buffer = Buffer.from(base64.replace(/\s/g, ''), 'base64')
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const extension = imageExtension(mediaType)
  const sessionDir = join(
    options.logsBasePath as string,
    getSessionLogRelativeDir(options.sessionId),
  )
  const relativePath = `images/${sha256}${extension}`
  const path = join(sessionDir, relativePath)

  try {
    mkdirSync(join(sessionDir, 'images'), { recursive: true })
    if (!existsSync(path)) {
      writeFileSync(path, buffer)
    }
    return {
      path,
      relativePath,
      sha256,
      bytes: buffer.length,
    }
  } catch (error) {
    return {
      path,
      relativePath,
      sha256,
      bytes: buffer.length,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function getImageMediaType(record: Record<string, unknown>): string | undefined {
  const mediaType =
    typeof record.mediaType === 'string'
      ? record.mediaType
      : typeof record.media_type === 'string'
        ? record.media_type
        : undefined
  if (!mediaType?.startsWith('image/')) return undefined
  return normalizeImageMediaType(mediaType)
}

function parseImageData(value: string): { mediaType: string; data: string } | undefined {
  const match = DATA_URL_RE.exec(value)
  if (!match) return undefined
  return {
    mediaType: normalizeImageMediaType(match[1]),
    data: match[2],
  }
}

function normalizeImageMediaType(mediaType: string): string {
  return mediaType === 'image/jpg' ? 'image/jpeg' : mediaType
}

function imageExtension(mediaType: string): string {
  switch (mediaType) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    default:
      return '.img'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
