import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Hono } from 'hono'
import katex from 'katex'
import { z } from 'zod'
import { htmlPreviewBodyStyle, htmlPreviewDocument } from './html-preview'
import { rasterizeHtml } from './rasterize-html'

// Content wider than this grows the PNG; an html preview fills it, as it fills the chat column in the app.
const VIEWPORT = { width: 720, height: 400 }

// The app's light theme (src/renderer/globals.css) as values: nothing here resolves the app's stylesheet.
export const MERMAID_THEME = { bg: 'hsl(0 0% 100%)', fg: 'hsl(0 0% 3.9%)', muted: 'hsl(0 0% 45.1%)', accent: 'hsl(204 100% 50%)', transparent: true }
export const HTML_THEME_TOKENS =
  '--background:0 0% 100%;--foreground:0 0% 3.9%;--card:0 0% 100%;--card-foreground:0 0% 3.9%;--primary:0 0% 9%;' +
  '--primary-foreground:0 0% 98%;--muted:0 0% 96.1%;--muted-foreground:0 0% 45.1%;--accent:0 0% 96.1%;' +
  '--destructive:0 84.2% 60.2%;--border:0 0% 89.8%;--ring:0 0% 63.9%;--radius:0.5rem;--chart-1:12 76% 61%;' +
  '--chart-2:173 58% 39%;--chart-3:197 37% 24%;--chart-4:43 74% 66%;--chart-5:27 87% 67%'

/** A document whose body shrinks to its content. */
function fittedDocument(body: string, head = ''): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0}body{width:max-content;padding:16px}</style>${head}</head><body>${body}</body></html>`
}

async function mermaidDocument(source: string): Promise<string> {
  // Native ESM import from the CommonJS container.
  const { renderMermaidSVG } = await import('beautiful-mermaid')
  // The embedded <style> pulls fonts from Google, which the offline render cannot reach.
  return fittedDocument(renderMermaidSVG(source, MERMAID_THEME).replace(/@import url\([^)]*\);/g, ''))
}

let katexCss: string | undefined

/** katex.min.css with its woff2 fonts as data URIs, since the render is offline. */
function inlinedKatexCss(): string {
  if (katexCss) return katexCss
  const dist = path.dirname(require.resolve('katex/dist/katex.min.css'))
  katexCss = fs.readFileSync(path.join(dist, 'katex.min.css'), 'utf8').replace(
    /src:url\(fonts\/([^)]+?)\.woff2\) format\("woff2"\)[^;}]*/g,
    (_, name: string) => `src:url(data:font/woff2;base64,${fs.readFileSync(path.join(dist, 'fonts', `${name}.woff2`)).toString('base64')}) format("woff2")`,
  )
  return katexCss
}

function mathDocument(source: string): string {
  return fittedDocument(katex.renderToString(source, { displayMode: true, throwOnError: true }), `<style>${inlinedKatexCss()}</style>`)
}

/** The app's html preview document, with the light theme's tokens as values in place of the app's live ones. */
function htmlDocument(source: string): string {
  const style =
    `:root{${HTML_THEME_TOKENS}}` +
    htmlPreviewBodyStyle('-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif') +
    'body{padding:16px}'
  return htmlPreviewDocument(source, 'light', `<style>${style}</style>`)
}

// Scripts run only for html, as only the app's html preview runs them.
const RENDER_KINDS = {
  mermaid: { document: mermaidDocument, scripts: false },
  math: { document: mathDocument, scripts: false },
  html: { document: htmlDocument, scripts: true },
}

const renderRequestSchema = z.object({ kind: z.enum(['mermaid', 'math', 'html']), source: z.string() })

/** POST /render - a mermaid, math or html fence as the app draws it, as PNG bytes. */
export function registerRenderRoute(app: Hono): void {
  app.post('/render', async (c) => {
    const parsed = renderRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const kind = RENDER_KINDS[parsed.data.kind]
    let html: string
    try {
      html = await kind.document(parsed.data.source)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 422)
    }
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'render-'))
    try {
      const png = path.join(dir, 'visual.png')
      const { written, error } = await rasterizeHtml([
        { html, viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light', scripts: kind.scripts, fit: true, path: png },
      ], c.req.raw.signal)
      if (!written.length) return c.json({ error: error ?? 'Nothing rendered' }, 500)
      c.header('Content-Type', 'image/png')
      return c.body(await fs.promises.readFile(png))
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })
}
