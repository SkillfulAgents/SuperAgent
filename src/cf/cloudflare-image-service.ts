/**
 * The org's image conversions on Cloudflare Images (the IMAGES binding). A Worker cannot start the
 * worker thread the local service decodes HEIC in, and the pixels of a full-size photo do not fit in
 * its memory: Cloudflare Images decodes outside the Worker.
 */
import type { ImagesBinding } from 'cloudflare:workers'
import type { ImageService } from '@shared/lib/images/image-service'

/** The binding's input limit. A larger file fails, so its caller keeps the original. */
const MAX_INPUT_BYTES = 20_000_000
const JPEG_QUALITY = 85

export class CloudflareImageService implements ImageService {
  constructor(private readonly images: ImagesBinding) {}

  heicToJpeg(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    return this.convert(input, { format: 'image/jpeg', quality: JPEG_QUALITY })
  }

  cleanPng(input: Uint8Array): Promise<Uint8Array> {
    return this.convert(input, { format: 'image/png' })
  }

  private async convert(input: Uint8Array, output: { format: 'image/jpeg' | 'image/png'; quality?: number }): Promise<Uint8Array<ArrayBuffer>> {
    if (input.byteLength > MAX_INPUT_BYTES) {
      throw new Error(`Image is ${input.byteLength} bytes; Cloudflare Images takes at most ${MAX_INPUT_BYTES}`)
    }
    const result = await this.images.input(new Blob([input as Uint8Array<ArrayBuffer>]).stream()).output(output)
    return new Uint8Array(await result.response().arrayBuffer())
  }
}
