import { basename } from 'node:path'
import { protectMarkdownCodeContent } from '../richtext/code-protection'
import {
  ITEM_FILE,
  ITEM_IMAGE,
  ITEM_VIDEO,
  ITEM_VOICE,
  MEDIA_FILE,
  MEDIA_IMAGE,
  MEDIA_VIDEO,
  MEDIA_VOICE,
} from './constants'

export interface MarkdownImageReference {
  alt: string
  reference: string
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g
const WIKILINK_IMAGE_RE = /!\[\[([^\]]+)\]\]/g

export function extractMarkdownImageReferences(content: string): {
  text: string
  images: MarkdownImageReference[]
} {
  if (!content.includes('![')) return { text: content, images: [] }

  const protectedContent = protectMarkdownCodeContent(content, 'WEIXIN_IMG')
  const images: MarkdownImageReference[] = []
  let processed = protectedContent.processed

  processed = processed.replace(WIKILINK_IMAGE_RE, (_match, reference: string) => {
    const normalized = reference.trim()
    if (normalized) {
      images.push({
        alt: basename(normalized).replace(/\.[^.]+$/, '') || 'image',
        reference: normalized,
      })
    }
    return ''
  })

  processed = processed.replace(MARKDOWN_IMAGE_RE, (_match, alt: string, reference: string) => {
    const normalized = reference.trim()
    if (normalized) images.push({ alt: alt.trim(), reference: normalized })
    return ''
  })

  return {
    text: cleanupTextAfterImageExtraction(protectedContent.restore(processed)),
    images,
  }
}

export function normalizeImageReference(reference: string): string {
  const trimmed = reference.trim()
  if (!trimmed.startsWith('file://')) return trimmed

  try {
    return new URL(trimmed).pathname
  } catch {
    return trimmed.replace(/^file:\/\//, '')
  }
}

export function cleanMimeType(value: string | null): string | undefined {
  const mime = value?.split(';')[0]?.trim().toLowerCase()
  return mime || undefined
}

export function filenameFromUrl(url: string, mimeHint?: string): string {
  try {
    const parsed = new URL(url)
    const name = basename(decodeURIComponent(parsed.pathname))
    return name || defaultImageFilename(mimeHint)
  } catch {
    return defaultImageFilename(mimeHint)
  }
}

export function defaultImageFilename(mimeHint?: string): string {
  switch (mimeHint) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'image.jpg'
    case 'image/gif':
      return 'image.gif'
    case 'image/webp':
      return 'image.webp'
    case 'image/bmp':
      return 'image.bmp'
    default:
      return 'image.png'
  }
}

export function pickMediaType(filename: string, mimeHint?: string): number {
  const lower = filename.toLowerCase()
  const mime = mimeHint?.toLowerCase() ?? ''
  if (mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp)$/.test(lower)) return MEDIA_IMAGE
  if (mime.startsWith('video/') || /\.(mp4|mov|webm)$/.test(lower)) return MEDIA_VIDEO
  if (mime.startsWith('audio/') || /\.(silk|mp3|wav|m4a|ogg)$/.test(lower)) return MEDIA_VOICE
  return MEDIA_FILE
}

export function buildOutboundMediaItem(params: {
  mediaType: number
  filename: string
  rawsize: number
  ciphertextSize: number
  encryptQueryParam: string
  aesKeyForApi: string
  rawfilemd5: string
}): Record<string, unknown> {
  const media = {
    encrypt_query_param: params.encryptQueryParam,
    aes_key: params.aesKeyForApi,
    encrypt_type: 1,
  }
  if (params.mediaType === MEDIA_IMAGE) {
    return { type: ITEM_IMAGE, image_item: { media, mid_size: params.ciphertextSize } }
  }
  if (params.mediaType === MEDIA_VIDEO) {
    return {
      type: ITEM_VIDEO,
      video_item: {
        media,
        video_size: params.ciphertextSize,
        play_length: 0,
        video_md5: params.rawfilemd5,
      },
    }
  }
  if (params.mediaType === MEDIA_VOICE) {
    return { type: ITEM_VOICE, voice_item: { media, playtime: 0 } }
  }
  return {
    type: ITEM_FILE,
    file_item: { media, file_name: params.filename, len: String(params.rawsize) },
  }
}

function cleanupTextAfterImageExtraction(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
