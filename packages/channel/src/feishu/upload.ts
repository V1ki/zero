import type * as lark from '@larksuiteoapi/node-sdk'

export function readFeishuUploadKey(
  response: unknown,
  key: 'file_key' | 'image_key',
): string | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null

  const record = response as Record<string, unknown>
  const topLevel = record[key]
  if (typeof topLevel === 'string') return topLevel

  const data = record.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null

  const nested = (data as Record<string, unknown>)[key]
  return typeof nested === 'string' ? nested : null
}

export async function uploadFeishuImageBuffer(
  client: lark.Client,
  buffer: Buffer,
): Promise<string | null> {
  const { Readable } = await import('node:stream')
  type ImageCreatePayload = NonNullable<Parameters<typeof client.im.image.create>[0]>
  const image = Readable.from(buffer) as unknown as NonNullable<ImageCreatePayload['data']>['image']

  const resp = await client.im.image.create({
    data: {
      image_type: 'message',
      image,
    },
  })

  return readFeishuUploadKey(resp, 'image_key')
}
