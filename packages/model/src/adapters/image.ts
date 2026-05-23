import { readFileSync } from 'node:fs'
import type { ImageBlock } from '@zero-os/shared'

export interface ResolvedImageBlock {
  mediaType: string
  data: string
}

export function resolveImageBlock(image: ImageBlock): ResolvedImageBlock | undefined {
  const inlineData = (image as { data?: string }).data
  if (inlineData) {
    return { mediaType: image.mediaType, data: inlineData }
  }

  const path = image.imageRef?.path
  if (!path) return undefined

  try {
    return {
      mediaType: image.mediaType,
      data: readFileSync(path).toString('base64'),
    }
  } catch {
    return undefined
  }
}
