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
  // Four bytes a pixel in the platform's order (BGRA), alpha last as the
  // frame finder reads it. Anything else is left to the JavaScript decoder.
  const data = image.toBitmap()
  if (data.length !== width * height * 4) return null
  return {
    width,
    height,
    data,
    shrink: (region, toWidth, toHeight) => image.crop(region).resize({ width: toWidth, height: toHeight, quality: 'best' }).toPNG(),
  }
}

/** Let computer use read screenshots with Electron's native image code. */
export function registerComputerUseScreenshotDecoder(): void {
  setCaptureDecoder(decodeCapture)
}
