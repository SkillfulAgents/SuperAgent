import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { HEIC_PREVIEW_MAX_SOURCE_BYTES } from '@shared/lib/utils/heic-preview'
import { imageService, setImageService } from '@shared/lib/images/image-service'
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

  describe('with a deployment image service', () => {
    afterEach(() => setImageService(null))

    it('converts through the service set at boot instead of the worker thread', async () => {
      const received: Uint8Array[] = []
      setImageService({
        ...imageService(),
        heicToJpeg: async (input) => {
          received.push(input)
          return new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
        },
      })

      const jpeg = await heicUploadAsJpeg('IMG_0002.heic', TINY_HEIC)

      expect(jpeg?.name).toBe('IMG_0002.jpg')
      expect([...jpeg!.data]).toEqual([0xff, 0xd8, 0xff, 0xd9])
      expect(received).toHaveLength(1)
      expect(received[0]).not.toBe(TINY_HEIC)
      expect(Buffer.from(received[0]).equals(TINY_HEIC)).toBe(true)
    })

    it('keeps the original when the service fails', async () => {
      setImageService({ ...imageService(), heicToJpeg: async () => { throw new Error('Unsupported image') } })
      await expect(heicUploadAsJpeg('IMG_0003.heic', TINY_HEIC)).resolves.toBeUndefined()
    })
  })
})
