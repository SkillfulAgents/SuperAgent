/**
 * Decodes, crops and shrinks agents' computer-use screenshots (see
 * shared/lib/computer-use/screenshot-frame.ts) with Electron's native image
 * code, in this process, where computer use runs.
 */
import { nativeImage } from 'electron'
import { setCaptureDecoder, type DecodedCapture } from '@shared/lib/computer-use/screenshot-frame'

function decodeCapture(png: Buffer): DecodedCapture | null {
  // Scale factor 1, so sizes and crop rectangles are in pixels.
  const image = nativeImage.createFromBuffer(png, { scaleFactor: 1 })
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  let bitmap: Buffer | undefined
  return {
    width,
    height,
    // Four bytes a pixel in the platform's order (BGRA), alpha last as the
    // frame finder reads it; anything else it leaves to the JavaScript
    // decoder. A copy of every pixel (24 MB for a Retina display), so made
    // only when asked for: a display capture is placed by its size alone.
    get data() {
      bitmap ??= image.toBitmap()
      return bitmap
    },
    shrink: (region, toWidth, toHeight) => image.crop(region).resize({ width: toWidth, height: toHeight, quality: 'best' }).toPNG(),
  }
}

/** Let computer use read screenshots with Electron's native image code. */
export function registerComputerUseScreenshotDecoder(): void {
  setCaptureDecoder(decodeCapture)
}
