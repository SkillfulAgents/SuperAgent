import path from 'node:path'
import { captureException } from '@shared/lib/error-reporting'
import { imageService } from '@shared/lib/images/image-service'
import { HEIC_PREVIEW_MAX_SOURCE_BYTES } from '@shared/lib/utils/heic-preview'

export const HEIC_EXTENSIONS = new Set(['.heic', '.heif'])

/** The agent's Read opens JPEG but not HEIC, so a HEIC someone sends is saved as a JPEG. */
export async function heicUploadAsJpeg(name: string, source: Blob | Uint8Array): Promise<{ name: string; data: Uint8Array<ArrayBuffer> } | undefined> {
  const extension = path.extname(name)
  const size = source instanceof Uint8Array ? source.byteLength : source.size
  if (!HEIC_EXTENSIONS.has(extension.toLowerCase()) || size > HEIC_PREVIEW_MAX_SOURCE_BYTES) return undefined
  try {
    // The image service takes the buffer it is given, so it gets a copy and the caller keeps the original.
    const input = new Uint8Array(source instanceof Uint8Array ? source : await source.arrayBuffer())
    const data = await imageService().heicToJpeg(input)
    return { name: `${name.slice(0, -extension.length)}.jpg`, data }
  } catch (error) {
    captureException(error, { tags: { component: 'agents', operation: 'heic-upload-as-jpeg' } })
    return undefined
  }
}
