import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { chromium } from 'playwright-core'

// Stable symlink created in Dockerfile after the install step. Points at the
// installed headless_shell (or full chrome) regardless of the revision that
// got fetched, so runtime code doesn't need to glob for revisions. If the
// file is missing the image build failed its chromium install step — which
// the build-time assert script catches loudly.
const CHROMIUM_PATH = '/opt/playwright-browsers/chromium-current'

const CAPTURE_TIMEOUT_MS = 15_000
const NAV_TIMEOUT_MS = 10_000
const SETTLE_MS = 500
const VIEWPORT = { width: 1280, height: 800 } as const

export const ScreenshotResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
])
export type ScreenshotResult = z.infer<typeof ScreenshotResultSchema>

/**
 * Return the path to the Chromium binary, or null if the stable symlink
 * created at build time is missing or non-executable. The parameter is a
 * seam for the build-time assert script to probe a different path if
 * needed — default is the canonical container location.
 */
export function resolveChromiumExecutable(
  binPath: string = CHROMIUM_PATH
): string | null {
  try {
    fs.accessSync(binPath, fs.constants.X_OK)
    return binPath
  } catch {
    return null
  }
}

/**
 * Capture a PNG screenshot of the given URL and write it to outPath.
 * Best-effort: always resolves with a discriminated union; never throws.
 * An overall timeout bounds the whole operation so a hung browser cannot
 * block the dashboard-start flow.
 */
export async function captureDashboardScreenshot(
  url: string,
  outPath: string
): Promise<ScreenshotResult> {
  const executablePath = resolveChromiumExecutable()
  if (!executablePath) {
    return ScreenshotResultSchema.parse({
      ok: false,
      reason: `No Chromium binary at ${CHROMIUM_PATH}`,
    })
  }

  const work = runCapture(executablePath, url, outPath)
  const timeout = new Promise<ScreenshotResult>((resolve) => {
    setTimeout(
      () =>
        resolve(
          ScreenshotResultSchema.parse({
            ok: false,
            reason: `Screenshot capture exceeded ${CAPTURE_TIMEOUT_MS}ms`,
          })
        ),
      CAPTURE_TIMEOUT_MS
    )
  })

  return Promise.race([work, timeout])
}

async function runCapture(
  executablePath: string,
  url: string,
  outPath: string
): Promise<ScreenshotResult> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS })
    await page.waitForTimeout(SETTLE_MS)
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true })
    await page.screenshot({ path: outPath, type: 'png', fullPage: false })
    return ScreenshotResultSchema.parse({ ok: true, path: outPath })
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    return ScreenshotResultSchema.parse({ ok: false, reason })
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch {
        // Ignore close errors — browser may already be dead.
      }
    }
  }
}
