import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageBlock } from '@zero-os/shared'
import { resolveImageBlock } from '../adapters/image'

describe('image ref resolution', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reads base64 data from imageRef path when inline data is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zero-image-ref-'))
    tempDirs.push(dir)
    const imagePath = join(dir, 'image.png')
    writeFileSync(imagePath, Buffer.from('restored-image'))

    const image = {
      type: 'image',
      mediaType: 'image/png',
      imageRef: {
        path: imagePath,
        relativePath: 'images/image.png',
        sha256: 'sha',
        bytes: Buffer.from('restored-image').length,
      },
    } as ImageBlock

    expect(resolveImageBlock(image)).toEqual({
      mediaType: 'image/png',
      data: Buffer.from('restored-image').toString('base64'),
    })
  })
})
