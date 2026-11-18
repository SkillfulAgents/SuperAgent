import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { rasterizeHtml } from './rasterize-html'

const CAPTURE_TIMEOUT_MS = 15_000
const VIEWPORT = { width: 1280, height: 800 } as const

export const ScreenshotResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
])
export type ScreenshotResult = z.infer<typeof ScreenshotResultSchema>

/**
 * Capture a PNG screenshot of the given URL and write it to outPath.
 * Best-effort: always resolves with a discriminated union; never throws.
 * An overall timeout bounds the whole operation so a hung browser cannot
 * block the dashboard-start flow.
 */
export async function captureDashboardScreenshot(url: string, outPath: string): Promise<ScreenshotResult> {
  try {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true })
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error(`Screenshot capture exceeded ${CAPTURE_TIMEOUT_MS}ms`)), CAPTURE_TIMEOUT_MS)
  const { written, error } = await rasterizeHtml(
    [{ url, viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'light', scripts: true, path: outPath }],
    deadline.signal,
  ).finally(() => clearTimeout(timer))
  return written.length ? { ok: true, path: outPath } : { ok: false, reason: error ?? 'Nothing captured' }
}
