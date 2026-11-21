import { describe, expect, it } from 'vitest'
import type { ImagesBinding } from 'cloudflare:workers'
import { CloudflareImageService } from './cloudflare-image-service'

function recordingImages(reply: Uint8Array) {
  const calls: { input: Uint8Array; output: unknown }[] = []
  const images: ImagesBinding = {
    input: (stream) => ({
      output: async (output) => {
        calls.push({ input: new Uint8Array(await new Response(stream).arrayBuffer()), output })
        return { response: () => new Response(reply as Uint8Array<ArrayBuffer>) }
      },
    }),
  }
  return { images, calls }
}

describe('CloudflareImageService', () => {
  it('sends a HEIC to Cloudflare Images and returns its JPEG', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    const { images, calls } = recordingImages(jpeg)

    const result = await new CloudflareImageService(images).heicToJpeg(new TextEncoder().encode('photo from a phone'))

    expect([...result]).toEqual([...jpeg])
    expect(new TextDecoder().decode(calls[0].input)).toBe('photo from a phone')
    expect(calls[0].output).toEqual({ format: 'image/jpeg', quality: 85 })
  })

  it('encodes a profile photo again as PNG', async () => {
    const { images, calls } = recordingImages(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))

    await new CloudflareImageService(images).cleanPng(new Uint8Array([1, 2, 3]))

    expect(calls[0].output).toEqual({ format: 'image/png' })
  })

  it('refuses a file over the binding limit without sending it', async () => {
    const { images, calls } = recordingImages(new Uint8Array())

    await expect(new CloudflareImageService(images).heicToJpeg(new Uint8Array(20_000_001))).rejects.toThrow('Cloudflare Images takes at most 20000000')
    expect(calls).toHaveLength(0)
  })
})
