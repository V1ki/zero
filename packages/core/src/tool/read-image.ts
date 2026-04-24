import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { BaseTool } from './base'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const SUPPORTED_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number]

interface ReadImageInput {
  path: string
}

export class ReadImageTool extends BaseTool {
  kind = 'built-in' as const
  name = 'read_image'
  description =
    'Read a local PNG, JPEG, or WebP image from the filesystem and attach it for visual analysis. Only local filesystem paths are supported; download remote images to a local file before using this tool.'
  parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Local filesystem path to a PNG, JPEG, or WebP image',
      },
    },
    required: ['path'],
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const { path } = input as ReadImageInput

    if (typeof path !== 'string' || path.length === 0) {
      return {
        success: false,
        output: 'read_image requires a non-empty local filesystem path.',
        outputSummary: 'Invalid image path',
      }
    }

    if (isRemoteOrFileUrl(path)) {
      return {
        success: false,
        output:
          'read_image only supports local filesystem paths. Download remote images to a local file first.',
        outputSummary: 'Remote image URLs are not supported',
      }
    }

    const resolvedPath = isAbsolute(path) ? path : resolve(ctx.workDir, path)
    if (!existsSync(resolvedPath)) {
      return {
        success: false,
        output: `File not found: ${resolvedPath}`,
        outputSummary: 'Image file not found',
      }
    }

    const stat = lstatSync(resolvedPath)
    if (!stat.isFile()) {
      return {
        success: false,
        output: `Path is not a file: ${resolvedPath}`,
        outputSummary: 'Image path is not a file',
      }
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      return {
        success: false,
        output: `Image is too large: ${stat.size} bytes. Maximum size is ${MAX_IMAGE_BYTES} bytes.`,
        outputSummary: 'Image exceeds size limit',
      }
    }

    const buffer = readFileSync(resolvedPath)
    const mediaType = detectImageMediaType(buffer)
    if (!mediaType) {
      return {
        success: false,
        output: `Unsupported or invalid image file: ${resolvedPath}. Supported formats: ${SUPPORTED_MEDIA_TYPES.join(', ')}`,
        outputSummary: 'Unsupported image format',
      }
    }

    const output = `Read image ${resolvedPath} (${mediaType}, ${buffer.length} bytes)`
    return {
      success: true,
      output,
      outputSummary: output,
      contentItems: [{ type: 'image', mediaType, data: buffer.toString('base64') }],
      artifacts: [resolvedPath],
    }
  }
}

function isRemoteOrFileUrl(path: string): boolean {
  return /^(https?:|file:)/i.test(path)
}

function detectImageMediaType(buffer: Buffer): SupportedMediaType | undefined {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png'
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }

  return undefined
}
