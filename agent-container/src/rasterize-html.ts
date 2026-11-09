import * as fs from 'fs'
import { chromium } from 'playwright-core'
import { resolveChromiumExecutable } from './dashboard-screenshot'

// One Chromium launch renders every shot of a call; the whole batch is bounded
// so a hung page cannot wedge the callers queued behind it.
const RASTER_TIMEOUT_MS = 30_000
const NAV_TIMEOUT_MS = 10_000
// Documents carry their data inline and load nothing, so a short settle is
// enough for fonts, transitions and inline scripts to land.
const SETTLE_MS = 150

export interface Shot {
  html: string
  viewport: { width: number; height: number }
  deviceScaleFactor: number
  colorScheme: 'light' | 'dark'
  /** Run the document's scripts. */
  scripts?: boolean
  /** Clip the PNG to the body's box instead of the viewport. */
  fit?: boolean
  /** Where the PNG goes. */
  path: string
}

export interface RasterizeHtmlResult {
  /** Paths of the shots written, in the order they were rendered. */
  written: string[]
  error: string | null
}

// Calls run one at a time: each launches a Chromium and the container has few
// CPUs.
let admission: Promise<unknown> = Promise.resolve()

/**
 * Render each shot's HTML to a PNG at its path, all in one Chromium launch.
 * Best-effort: never throws, reports what it managed to render plus the first
 * error. Skipped when `signal` has aborted by the time the call is admitted.
 */
export function rasterizeHtml(shots: Shot[], signal?: AbortSignal): Promise<RasterizeHtmlResult> {
  const started = admission.then(() => startRasterize(shots, signal))
  // The next call waits for this one's browser to close, not for its caller's
  // timeout; a failure here must not stall the calls behind it.
  admission = started.then(({ work }) => work).catch(() => {})
  return started.then(({ result }) => result)
}

/** The bounded result for the caller, and the work itself, which ends once the browser has closed. */
function startRasterize(shots: Shot[], signal?: AbortSignal): { result: Promise<RasterizeHtmlResult>; work: Promise<RasterizeHtmlResult> } {
  if (signal?.aborted) {
    const result = Promise.resolve({ written: [], error: 'Abandoned while queued' })
    return { result, work: result }
  }
  const executablePath = resolveChromiumExecutable()
  if (!executablePath) {
    const result = Promise.resolve({ written: [], error: 'No Chromium binary available for rasterization' })
    return { result, work: result }
  }

  const written: string[] = []
  // The timeout has to STOP the work, not just stop waiting for it: a race
  // that only resolves early would leave a Chromium running in a container
  // with few CPUs, still renaming PNGs into place long after the caller has
  // recorded which files exist.
  const run: RasterizeRun = { aborted: false, browser: null }
  const work = runRasterize(executablePath, shots, written, run)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<RasterizeHtmlResult>((resolve) => {
    timer = setTimeout(() => {
      run.aborted = true
      void run.browser?.close().catch(() => {})
      resolve({ written: [...written], error: `Rasterization exceeded ${RASTER_TIMEOUT_MS}ms` })
    }, RASTER_TIMEOUT_MS)
  })
  return { result: Promise.race([work, timeout]).finally(() => clearTimeout(timer)), work }
}

interface RasterizeRun {
  aborted: boolean
  browser: Awaited<ReturnType<typeof chromium.launch>> | null
}

async function runRasterize(
  executablePath: string,
  shots: Shot[],
  written: string[],
  run: RasterizeRun,
): Promise<RasterizeHtmlResult> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  let error: string | null = null
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    run.browser = browser
    // Launching may itself have outrun the timeout, which has nothing to close
    // yet at that point.
    if (run.aborted) return { written: [...written], error: 'Rasterization aborted' }

    for (const shot of shots) {
      if (run.aborted) return { written: [...written], error: error ?? 'Rasterization aborted' }
      const context = await browser.newContext({
        viewport: shot.viewport,
        deviceScaleFactor: shot.deviceScaleFactor,
        colorScheme: shot.colorScheme,
        // The PNG has to show what the app shows. Scripts run only where the
        // app runs them (html previews, not widget snapshots), and the
        // network is never available: either would put content in the PNG
        // the user can never see in the app.
        javaScriptEnabled: shot.scripts ?? false,
        offline: true,
      })
      try {
        const page = await context.newPage()
        // setContent, not a file:// navigation. Loading the file gives the
        // document a directory to resolve against, and `./chart.css` or a
        // sibling PNG then renders into the preview even though the app —
        // which inlines the same document under `default-src 'none'` —
        // refuses them. No file base, and the policy travels in the
        // document, so the two agree.
        await page.setContent(shot.html, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS })
        await page.waitForTimeout(SETTLE_MS)
        // Written to a temp name then renamed so a reader never sees a
        // half-written PNG (the host serves these straight off disk).
        const tmpPath = `${shot.path}.tmp`
        if (shot.fit) await page.locator('body').screenshot({ path: tmpPath, type: 'png' })
        else await page.screenshot({ path: tmpPath, type: 'png', fullPage: false })
        await fs.promises.rename(tmpPath, shot.path)
        written.push(shot.path)
      } catch (err: unknown) {
        error ??= err instanceof Error ? err.message : String(err)
      } finally {
        await context.close().catch(() => {})
      }
    }
  } catch (err: unknown) {
    error ??= err instanceof Error ? err.message : String(err)
  } finally {
    // Browser may already be gone.
    if (browser) await browser.close().catch(() => {})
  }
  return { written: [...written], error }
}
