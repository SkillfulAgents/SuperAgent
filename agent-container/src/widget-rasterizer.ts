import * as fs from 'fs'
import * as path from 'path'
import { rasterizeHtml } from './rasterize-html'
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
  const htmlPath = path.join(widgetDir, WIDGET_HTML_FILENAME)
  if (!fs.existsSync(htmlPath)) {
    return { rendered: [], error: `${WIDGET_HTML_FILENAME} is missing` }
  }

  const outDir = path.join(widgetDir, 'snapshots')
  let html: string
  try {
    fs.mkdirSync(outDir, { recursive: true })
    html = fs.readFileSync(htmlPath, 'utf-8')
  } catch (err: unknown) {
    return { rendered: [], error: err instanceof Error ? err.message : String(err) }
  }
  // Rendered once per scheme rather than per screenshot: the same eight
  // renders come from two documents.
  const documents: Record<WidgetScheme, string> = {
    light: renderWidgetDocument(html, 'light'),
    dark: renderWidgetDocument(html, 'dark'),
  }
  const shots = WIDGET_SIZES.flatMap((size) =>
    WIDGET_SCHEMES.flatMap((scheme) =>
      WIDGET_SCALES.map((scale) => ({
        html: documents[scheme],
        viewport: WIDGET_FAMILY_VIEWPORTS[size],
        deviceScaleFactor: scale,
        colorScheme: scheme,
        path: path.join(outDir, snapshotFileName(size, scheme, scale)),
      })),
    ),
  )

  const { written, error } = await rasterizeHtml(shots)
  return { rendered: written.map((file) => path.basename(file, '.png')), error }
}
