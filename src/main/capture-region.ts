import type { WebContents } from 'electron'
import { z } from 'zod'

const coordinate = z.number().finite().min(0).max(100_000)
const extent = z.number().finite().positive().max(100_000)

/** A region of the asking page, in its CSS pixels. */
export const captureRegionSchema = z.object({ x: coordinate, y: coordinate, width: extent, height: extent })

/**
 * A page can hold a capture forever (see target-switch-overlay); the person is
 * waiting on this one to start a comment, so a slow capture costs the
 * screenshot, not the comment.
 */
const CAPTURE_BUDGET_MS = 3_000

/**
 * A PNG of one region of `contents` as it is on screen, at device resolution:
 * what the person saw of a dashboard when they commented on it. Null when the
 * region is malformed, the capture fails, or it runs past its budget.
 */
export async function captureRegion(
  contents: Pick<WebContents, 'capturePage' | 'getZoomFactor'>,
  raw: unknown,
  budgetMs = CAPTURE_BUDGET_MS,
): Promise<Uint8Array | null> {
  const parsed = captureRegionSchema.safeParse(raw)
  if (!parsed.success) return null
  // capturePage takes the page's DIPs; a zoomed page's CSS pixels are larger.
  const zoom = contents.getZoomFactor()
  const { x, y, width, height } = parsed.data
  const rect = {
    x: Math.round(x * zoom),
    y: Math.round(y * zoom),
    width: Math.max(1, Math.round(width * zoom)),
    height: Math.max(1, Math.round(height * zoom)),
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const image = await Promise.race([
      contents.capturePage(rect),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs) }),
    ])
    if (!image || image.isEmpty()) return null
    return image.toPNG()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
