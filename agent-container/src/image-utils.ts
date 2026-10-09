/**
 * Image utilities for resizing screenshots before sending to the LLM.
 *
 * Anthropic API limits:
 *  - ≤20 images per request: max 8000×8000 px
 *  - >20 images per request: max 2000×2000 px
 *  - Server-side resize threshold: long edge >1568 px OR >~1,600 tokens
 *
 * Token cost: tokens = (width × height) / 750
 * ~1,600 tokens = ~1,200,000 pixels (1.15 megapixels)
 *
 * We enforce both constraints to avoid server-side downscaling:
 *  1. Neither dimension exceeds 1568 px
 *  2. Total pixel count stays under 1,200,000 (~1.15 MP)
 *
 * This matches the table of optimal sizes from the Anthropic docs:
 *  1:1  → 1092×1092,  3:4 → 951×1268,  2:3 → 896×1344, etc.
 */

import sharp from 'sharp'

const MAX_DIMENSION = 1568
const MAX_PIXELS = 1_200_000

/**
 * Resize a screenshot buffer to stay within Anthropic's optimal image limits.
 * Enforces both max dimension (1568px) and max pixel count (1.15MP).
 * Returns the resized buffer and the output MIME type.
 * If the image is already within limits, returns it unchanged.
 *
 * `pixelRatio` first brings a high-DPI capture back to CSS pixels, so the
 * model pays for, and clicks in, the same coordinates the page uses.
 */
export async function resizeScreenshot(
  input: Buffer,
  mimeType: string,
  { pixelRatio = 1 }: { pixelRatio?: number } = {},
): Promise<{ data: Buffer; mimeType: string; resized: boolean }> {
  try {
    const metadata = await sharp(input).metadata()
    const ratio = Number.isFinite(pixelRatio) && pixelRatio > 1 ? pixelRatio : 1
    const width = Math.round((metadata.width ?? 0) / ratio)
    const height = Math.round((metadata.height ?? 0) / ratio)

    const withinDimensions = width <= MAX_DIMENSION && height <= MAX_DIMENSION
    const withinPixels = width * height <= MAX_PIXELS

    if (ratio === 1 && withinDimensions && withinPixels) {
      return { data: input, mimeType, resized: false }
    }

    // Compute target dimensions respecting both constraints
    let targetWidth = width
    let targetHeight = height

    // First, clamp the longest edge to MAX_DIMENSION
    if (!withinDimensions) {
      const scale = MAX_DIMENSION / Math.max(width, height)
      targetWidth = Math.round(width * scale)
      targetHeight = Math.round(height * scale)
    }

    // Then, if still over the pixel budget, scale down further
    if (targetWidth * targetHeight > MAX_PIXELS) {
      const scale = Math.sqrt(MAX_PIXELS / (targetWidth * targetHeight))
      targetWidth = Math.round(targetWidth * scale)
      targetHeight = Math.round(targetHeight * scale)
    }

    const resized = await sharp(input)
      .resize({ width: targetWidth, height: targetHeight, fit: 'inside' })
      .png()
      .toBuffer()

    return { data: resized, mimeType: 'image/png', resized: true }
  } catch {
    // If sharp fails (corrupt image, unsupported format), return the original
    return { data: input, mimeType, resized: false }
  }
}

/**
 * Resize a base64-encoded image. Convenience wrapper around resizeScreenshot.
 */
export async function resizeBase64Screenshot(
  base64: string,
  mimeType: string,
): Promise<{ base64: string; mimeType: string; resized: boolean }> {
  const input = Buffer.from(base64, 'base64')
  const result = await resizeScreenshot(input, mimeType)
  return {
    base64: result.data.toString('base64'),
    mimeType: result.mimeType,
    resized: result.resized,
  }
}
