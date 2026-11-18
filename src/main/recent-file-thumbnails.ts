import fs from 'fs'
import path from 'path'
import type { nativeImage as ElectronNativeImage } from 'electron'

export interface RecentFile {
  name: string
  path: string
  thumbnail?: string
}

/** The part of Electron's `nativeImage` this module uses; the caller passes it in. */
export type ThumbnailImageApi = Pick<typeof ElectronNativeImage, 'createFromPath' | 'createThumbnailFromPath'>

export interface ThumbnailOptions {
  platform?: NodeJS.Platform
  /** A file whose thumbnail takes longer than this is listed without one. */
  timeoutMs?: number
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/**
 * The box asked of the OS thumbnailer, in points; the OS multiplies by the
 * screen's scale. The menus draw a thumbnail in a 20 pt square with
 * `object-cover`, so the shorter side is the one that has to fill it: 64 keeps
 * that side at 20 pt or more down to a 3:1 picture.
 */
const THUMBNAIL_BOX = 64
/** Width in pixels of the thumbnail made by decoding the file in this process. */
const DECODED_WIDTH = 32
/** The renderer asks for 5 files and the handler allows 20. */
const MAX_CONCURRENT = 4
const DEFAULT_TIMEOUT_MS = 1500

/**
 * Adds a small PNG data-URL thumbnail to each recent file that is an image,
 * leaving the others, and any image that cannot be drawn, as they came.
 *
 * On macOS the OS thumbnailer (Quick Look) draws it, off the main thread and
 * from its own cache. Elsewhere the file is decoded in this process, which
 * blocks while it does: Electron's `createThumbnailFromPath` is synchronous on
 * Windows and absent on Linux.
 */
export async function addImageThumbnails(
  files: RecentFile[],
  images: ThumbnailImageApi,
  options: ThumbnailOptions = {},
): Promise<RecentFile[]> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') return files.map((file) => withDecodedThumbnail(file, images))

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const result = files.slice()
  let next = 0
  const worker = async () => {
    while (next < files.length) {
      const index = next++
      const file = files[index]
      if (!IMAGE_EXTS.has(path.extname(file.name).toLowerCase())) continue
      const thumbnail = await withTimeout(quickLookThumbnail(file.path, images), timeoutMs)
      if (thumbnail) result[index] = { ...file, thumbnail }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, files.length) }, worker))
  return result
}

async function quickLookThumbnail(filePath: string, images: ThumbnailImageApi): Promise<string | undefined> {
  try {
    // Quick Look answers a file it cannot draw with a generic document icon.
    // The menus show their own file-type icon in that case, so ask only for
    // files that start like an image.
    if (!(await startsLikeAnImage(filePath))) return undefined
    const image = await images.createThumbnailFromPath(filePath, { width: THUMBNAIL_BOX, height: THUMBNAIL_BOX })
    if (image.isEmpty()) return undefined
    // toPNG() encodes the densest representation: the pixels Quick Look drew,
    // in the picture's own proportions.
    return toDataUrl(image.toPNG())
  } catch {
    return undefined
  }
}

function withDecodedThumbnail(file: RecentFile, images: ThumbnailImageApi): RecentFile {
  if (!IMAGE_EXTS.has(path.extname(file.name).toLowerCase())) return file
  try {
    const image = images.createFromPath(file.path)
    if (image.isEmpty()) return file
    // Only constrain width — let height scale to preserve aspect ratio
    const resized = image.resize({ width: DECODED_WIDTH, quality: 'good' })
    return { ...file, thumbnail: toDataUrl(resized.toPNG()) }
  } catch {
    return file
  }
}

function toDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

/** True when the file's first bytes are the signature of a format in IMAGE_EXTS. */
async function startsLikeAnImage(filePath: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const head = Buffer.alloc(12)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const startsWith = (bytes: number[], offset = 0) =>
      bytesRead >= offset + bytes.length && bytes.every((byte, i) => head[offset + i] === byte)
    return (
      startsWith([0x89, 0x50, 0x4e, 0x47]) || // PNG
      startsWith([0xff, 0xd8, 0xff]) || // JPEG
      startsWith([0x47, 0x49, 0x46, 0x38]) || // GIF8
      startsWith([0x42, 0x4d]) || // BM
      (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) // RIFF....WEBP
    )
  } finally {
    await handle.close()
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}
