import type * as lark from '@larksuiteoapi/node-sdk'
import { protectMarkdownCodeContent } from '../richtext/code-protection'
import { readFeishuImageReferenceBuffer } from './image-source'
import { uploadFeishuImageBuffer } from './upload'

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

export interface FeishuImageResolverOptions {
  client: lark.Client
  onImageResolved?: () => void
}

export interface FeishuImageReference {
  alt: string
  reference: string
}

/**
 * Resolves markdown image references to Feishu image keys.
 */
export class FeishuImageResolver {
  private readonly client: lark.Client
  private readonly onImageResolved: (() => void) | undefined
  private readonly resolved = new Map<string, string>()
  private readonly pending = new Map<string, Promise<string | null>>()
  private readonly failed = new Set<string>()

  constructor(opts: FeishuImageResolverOptions) {
    this.client = opts.client
    this.onImageResolved = opts.onImageResolved
  }

  hasImages(text: string): boolean {
    return text.includes('![')
  }

  resolveSync(text: string): string {
    if (!this.hasImages(text)) return text

    const protectedContent = this.protectCodeContent(text)
    let processed = protectedContent.processed

    processed = processed.replace(IMAGE_RE, (fullMatch, alt: string, value: string) => {
      if (value.startsWith('img_')) return fullMatch
      if (value.startsWith('data:')) return ''

      const cacheKey = value
      const cached = this.resolved.get(cacheKey)
      if (cached) {
        return `![${alt}](${cached})`
      }

      if (this.failed.has(cacheKey)) return ''
      if (this.pending.has(cacheKey)) return ''

      this.startUpload(cacheKey)
      return ''
    })

    return protectedContent.restore(processed)
  }

  async resolveAll(text: string, timeoutMs = 30_000): Promise<string> {
    this.resolveSync(text)

    if (this.pending.size > 0) {
      console.log(`[FeishuImageResolver] Waiting for ${this.pending.size} image upload(s)...`)
      const allUploads = Promise.allSettled([...this.pending.values()])
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs)
      })
      await Promise.race([allUploads, timeout])

      if (this.pending.size > 0) {
        console.warn(`[FeishuImageResolver] Timed out with ${this.pending.size} pending upload(s)`)
      }
    }

    return this.resolveSync(text)
  }

  async uploadBuffer(buffer: Buffer): Promise<string | null> {
    try {
      return await this.doUploadBuffer(buffer)
    } catch (error) {
      console.warn('[FeishuImageResolver] Buffer upload failed:', error)
      return null
    }
  }

  get pendingCount(): number {
    return this.pending.size
  }

  collectUnresolved(text: string): FeishuImageReference[] {
    if (!this.hasImages(text)) return []

    const unresolved: FeishuImageReference[] = []
    const seen = new Set<string>()
    const { processed } = this.protectCodeContent(text)

    processed.replace(IMAGE_RE, (fullMatch, alt: string, value: string) => {
      if (value.startsWith('img_')) return fullMatch
      if (this.resolved.has(value)) return fullMatch
      if (seen.has(value)) return fullMatch

      seen.add(value)
      unresolved.push({ alt, reference: value })
      return fullMatch
    })

    return unresolved
  }

  private startUpload(reference: string): void {
    const promise = this.doUpload(reference)
    this.pending.set(reference, promise)
  }

  private protectCodeContent(text: string): {
    processed: string
    restore: (input: string) => string
  } {
    return protectMarkdownCodeContent(text, 'IMG')
  }

  private async doUpload(reference: string): Promise<string | null> {
    try {
      const buffer = await readFeishuImageReferenceBuffer(reference)
      const imageKey = await this.doUploadBuffer(buffer)
      this.pending.delete(reference)

      if (!imageKey) {
        this.failed.add(reference)
        return null
      }

      this.resolved.set(reference, imageKey)
      this.onImageResolved?.()
      return imageKey
    } catch (error) {
      this.pending.delete(reference)
      this.failed.add(reference)
      console.warn(`[FeishuImageResolver] Upload failed for ${reference}:`, error)
      return null
    }
  }

  private async doUploadBuffer(buffer: Buffer): Promise<string | null> {
    const imageKey = await uploadFeishuImageBuffer(this.client, buffer)
    if (!imageKey) {
      console.warn('[FeishuImageResolver] Upload returned no image_key')
      return null
    }

    console.log(`[FeishuImageResolver] Uploaded -> ${imageKey}`)
    return imageKey
  }
}
