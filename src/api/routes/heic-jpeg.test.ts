import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HEIC_PREVIEW_MAX_SOURCE_BYTES } from '@shared/lib/utils/heic-preview'
import { heicUploadAsJpeg } from './heic-jpeg'

const TINY_HEIC = readFileSync(new URL('../../../e2e/fixtures/tiny.heic', import.meta.url))

describe('heicUploadAsJpeg', () => {
  it('turns a HEIC into a JPEG of the same name', async () => {
    const jpeg = await heicUploadAsJpeg('IMG_0001.HEIC', TINY_HEIC)
    expect(jpeg?.name).toBe('IMG_0001.jpg')
    expect([...jpeg!.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
  })

  it('leaves a Buffer that fails to decode intact for the caller to save', async () => {
    const original = Buffer.from(new TextEncoder().encode('not an image').buffer)
    await expect(heicUploadAsJpeg('broken.heic', original)).resolves.toBeUndefined()
    expect(original.toString()).toBe('not an image')
  })

  it.each([
    ['over the size cap', 'huge.heic', new Blob([new Uint8Array(HEIC_PREVIEW_MAX_SOURCE_BYTES + 1)])],
  ])('keeps the file as it is when it is %s', async (_case, name, source) => {
    await expect(heicUploadAsJpeg(name, source)).resolves.toBeUndefined()
  })
})
