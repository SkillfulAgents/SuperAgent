import * as fs from 'fs'
import * as path from 'path'
import { chromium } from 'playwright-core'
import { resolveChromiumExecutable } from './dashboard-screenshot'
import {
  WIDGET_FAMILY_VIEWPORTS,
  WIDGET_HTML_FILENAME,
  WIDGET_SCALES,
  WIDGET_SCHEMES,
  WIDGET_SIZES,
  renderWidgetDocument,
  snapshotFileName,
  type WidgetScheme,
} from './widget-schema'

// One Chromium launch renders every family × scheme × scale of a widget; the
// whole batch is bounded so a hung page cannot wedge the refresh queue.
const RASTER_TIMEOUT_MS = 30_000
const NAV_TIMEOUT_MS = 10_000
// Widgets are static HTML with data baked in, so a short settle is enough for
// fonts and CSS transitions to land.
const SETTLE_MS = 150

export interface RasterizeResult {
  rendered: string[]
  error: string | null
}

/**
 * Render <widgetDir>/widget.html into <widgetDir>/snapshots/<size>-<scheme>@<scale>x.png
 * for every supported family, colour scheme and device scale. Best-effort:
 * never throws, reports what it managed to render plus the first error.
 *
 * Colour scheme is applied two ways so both authoring conventions work:
 * `emulateMedia` flips `prefers-color-scheme`, and `data-theme` on <html>
 * matches the explicit override the in-app iframe uses.
 */
export async function rasterizeWidget(widgetDir: string): Promise<RasterizeResult> {
  const executablePath = resolveChromiumExecutable()
  if (!executablePath) {
    return { rendered: [], error: 'No Chromium binary available for widget rasterization' }
  }
  const htmlPath = path.join(widgetDir, WIDGET_HTML_FILENAME)
  if (!fs.existsSync(htmlPath)) {
    return { rendered: [], error: `${WIDGET_HTML_FILENAME} is missing` }
  }

  const rendered: string[] = []
  // The timeout has to STOP the work, not just stop waiting for it: a race
  // that only resolves early would leave a Chromium running in a container
  // with few CPUs, still renaming PNGs into snapshots/ long after
  // snapshot.json has recorded which files exist.
  const run: RasterizeRun = { aborted: false, browser: null }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<RasterizeResult>((resolve) => {
    timer = setTimeout(() => {
      run.aborted = true
      void run.browser?.close().catch(() => {})
      resolve({ rendered: [...rendered], error: `Rasterization exceeded ${RASTER_TIMEOUT_MS}ms` })
    }, RASTER_TIMEOUT_MS)
  })
  try {
    return await Promise.race([runRasterize(executablePath, widgetDir, htmlPath, rendered, run), timeout])
  } finally {
    clearTimeout(timer)
  }
}

interface RasterizeRun {
  aborted: boolean
  browser: Awaited<ReturnType<typeof chromium.launch>> | null
}

async function runRasterize(
  executablePath: string,
  widgetDir: string,
  htmlPath: string,
  rendered: string[],
  run: RasterizeRun,
): Promise<RasterizeResult> {
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
    if (run.aborted) return { rendered: [...rendered], error: 'Rasterization aborted' }
    const outDir = path.join(widgetDir, 'snapshots')
    await fs.promises.mkdir(outDir, { recursive: true })
    // Rendered once per scheme rather than per screenshot: the same eight
    // renders come from two documents.
    const html = await fs.promises.readFile(htmlPath, 'utf-8')
    const documents: Record<WidgetScheme, string> = {
      light: renderWidgetDocument(html, 'light'),
      dark: renderWidgetDocument(html, 'dark'),
    }

    for (const size of WIDGET_SIZES) {
      for (const scheme of WIDGET_SCHEMES) {
        for (const scale of WIDGET_SCALES) {
          if (run.aborted) return { rendered: [...rendered], error: error ?? 'Rasterization aborted' }
          const context = await browser.newContext({
            viewport: WIDGET_FAMILY_VIEWPORTS[size],
            deviceScaleFactor: scale,
            colorScheme: scheme,
            // The PNG has to show what the app shows. In the app the snapshot
            // renders in an empty sandbox under `default-src 'none'`, so
            // rendering it here with scripts and the network available would
            // put content in the preview that the user can never see — and run
            // the page's side effects once per size, scheme and scale.
            javaScriptEnabled: false,
            offline: true,
          })
          try {
            const page = await context.newPage()
            // setContent, not a file:// navigation. Loading the file gives the
            // document a directory to resolve against, and `./chart.css` or a
            // sibling PNG then renders into the preview even though the app —
            // which inlines the same document under `default-src 'none'` —
            // refuses them. No file base, and the policy travels in the
            // document, so the two agree. It also carries data-theme, which
            // used to be set by evaluating in the page: that needs the
            // scripting this context deliberately does not have.
            await page.setContent(documents[scheme], { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS })
            await page.waitForTimeout(SETTLE_MS)
            const fileName = snapshotFileName(size, scheme, scale)
            // Written to a temp name then renamed so a reader never sees a
            // half-written PNG (the host serves these straight off disk).
            const finalPath = path.join(outDir, fileName)
            const tmpPath = `${finalPath}.tmp`
            await page.screenshot({ path: tmpPath, type: 'png', fullPage: false })
            await fs.promises.rename(tmpPath, finalPath)
            rendered.push(fileName.replace(/\.png$/, ''))
          } catch (err: unknown) {
            error ??= err instanceof Error ? err.message : String(err)
          } finally {
            await context.close().catch(() => {})
          }
        }
      }
    }
  } catch (err: unknown) {
    error ??= err instanceof Error ? err.message : String(err)
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch {
        // Browser may already be gone.
      }
    }
  }
  return { rendered: [...rendered], error }
}
