import * as fs from 'fs'
import type { Browser, BrowserServer } from 'playwright-core'
import { resolveChromiumExecutable } from './chromium-executable'
import { loadChromium } from './load-chromium'
import { withinStopDeadline } from './stop-deadline'

// One Chromium launch renders every shot of a call; the whole batch is bounded
// so a hung page cannot wedge the callers queued behind it.
const RASTER_TIMEOUT_MS = 30_000
// How long past the raster limit the next call waits for a browser to close before killing it.
const CLOSE_GRACE_MS = 5_000
const NAV_TIMEOUT_MS = 10_000
// Documents carry their data inline and load nothing, so a short settle is
// enough for fonts, transitions and inline scripts to land.
const SETTLE_MS = 150
// A page loads from its own server, so it gets longer for its data to arrive.
const PAGE_SETTLE_MS = 500

/** A document to render offline (`html`), or a page to open with the network on (`url`). */
export type Shot = ({ html: string } | { url: string }) & {
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
 * Render each shot to a PNG at its path, all in one Chromium launch.
 * Best-effort: never throws, reports what it managed to render plus the first
 * error. Skipped when `signal` has aborted by the time the call is admitted,
 * and stopped when it aborts during the render.
 */
export function rasterizeHtml(shots: Shot[], signal?: AbortSignal): Promise<RasterizeHtmlResult> {
  const started = admission.then(() => startRasterize(shots, signal))
  // The next call waits for this one's browser to close, not for its caller's
  // timeout; a failure here must not stall the calls behind it.
  admission = started.then(closedOrKilled).catch(() => {})
  const result = started.then(({ result }) => result)
  // A caller that gives up while still queued gets its answer now; its turn is skipped when it comes.
  return signal ? withinStopDeadline(result, signal).catch(() => ({ written: [], error: abandonedBecause(signal) })) : result
}

/** Why a caller gave up: its own reason (a timeout's message), else that it gave up. */
function abandonedBecause(signal: AbortSignal): string {
  return signal.reason instanceof Error && signal.reason.name !== 'AbortError' ? signal.reason.message : 'Abandoned by the caller'
}

/** `work`, or a rejection once `ms` pass. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return withinStopDeadline(work, controller.signal).finally(() => clearTimeout(timer))
}

/** Waits for a call's browser to close, but not past the raster limit plus a grace: a close that hangs is killed, and the kill is bounded too. */
async function closedOrKilled({ work, kill }: { work: Promise<unknown>; kill: () => Promise<void> }): Promise<void> {
  await within(work, RASTER_TIMEOUT_MS + CLOSE_GRACE_MS).catch(() => within(kill(), CLOSE_GRACE_MS)).catch(() => {})
}

interface Started {
  /** The bounded result for the caller. */
  result: Promise<RasterizeHtmlResult>
  /** The work itself, which ends once the browser has closed. */
  work: Promise<RasterizeHtmlResult>
  kill: () => Promise<void>
}

function startRasterize(shots: Shot[], signal?: AbortSignal): Started {
  const settled = (error: string): Started => {
    const result = Promise.resolve({ written: [], error })
    return { result, work: result, kill: async () => {} }
  }
  if (signal?.aborted) return settled('Abandoned while queued')
  const executablePath = resolveChromiumExecutable()
  if (!executablePath) return settled('No Chromium binary available for rasterization')

  const written: string[] = []
  // The timeout has to STOP the work, not just stop waiting for it: a race
  // that only resolves early would leave a Chromium running in a container
  // with few CPUs, still renaming PNGs into place long after the caller has
  // recorded which files exist.
  const run: RasterizeRun = { aborted: false, server: null }
  const work = runRasterize(executablePath, shots, written, run)
  let stop: (error: string) => void = () => {}
  const stopped = new Promise<RasterizeHtmlResult>((resolve) => {
    stop = (error) => {
      run.aborted = true
      void run.server?.close().catch(() => {})
      resolve({ written: [...written], error })
    }
  })
  const timer = setTimeout(() => stop(`Rasterization exceeded ${RASTER_TIMEOUT_MS}ms`), RASTER_TIMEOUT_MS)
  const abandon = () => stop(signal ? abandonedBecause(signal) : 'Abandoned by the caller')
  signal?.addEventListener('abort', abandon, { once: true })
  const result = Promise.race([work, stopped]).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abandon)
  })
  return { result, work, kill: () => run.server?.kill() ?? Promise.resolve() }
}

interface RasterizeRun {
  aborted: boolean
  server: BrowserServer | null
}

async function runRasterize(
  executablePath: string,
  shots: Shot[],
  written: string[],
  run: RasterizeRun,
): Promise<RasterizeHtmlResult> {
  let server: BrowserServer | null = null
  let error: string | null = null
  try {
    const chromium = await loadChromium()
    // A server rather than a plain launch: only a server's process can be killed when closing it hangs.
    server = await chromium.launchServer({
      // The server's control socket is for this process only.
      host: '127.0.0.1',
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    run.server = server
    // Launching may itself have outrun the timeout, which had nothing to close
    // yet at that point.
    if (run.aborted) return { written: [...written], error: 'Rasterization aborted' }
    const browser: Browser = await chromium.connect(server.wsEndpoint())

    for (const shot of shots) {
      if (run.aborted) return { written: [...written], error: error ?? 'Rasterization aborted' }
      const fromServer = 'url' in shot
      const context = await browser.newContext({
        viewport: shot.viewport,
        deviceScaleFactor: shot.deviceScaleFactor,
        colorScheme: shot.colorScheme,
        // The PNG has to show what the app shows. Scripts run only where the
        // app runs them (html previews, not widget snapshots), and a document
        // never has the network: either would put content in the PNG the user
        // can never see in the app. A page opened by URL loads from its server.
        javaScriptEnabled: shot.scripts ?? false,
        offline: !fromServer,
      })
      try {
        const page = await context.newPage()
        // setContent, not a file:// navigation. Loading the file gives the
        // document a directory to resolve against, and `./chart.css` or a
        // sibling PNG then renders into the preview even though the app —
        // which inlines the same document under `default-src 'none'` —
        // refuses them. No file base, and the policy travels in the
        // document, so the two agree.
        if ('url' in shot) await page.goto(shot.url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS })
        else await page.setContent(shot.html, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS })
        await page.waitForTimeout(fromServer ? PAGE_SETTLE_MS : SETTLE_MS)
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
    // Closing the server ends the browser process; it may already be gone.
    if (server) await server.close().catch(() => {})
  }
  return { written: [...written], error }
}
