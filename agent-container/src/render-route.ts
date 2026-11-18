import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Hono } from 'hono'
import katex from 'katex'
import { z } from 'zod'
import { rasterizeHtml } from './rasterize-html'

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

// Only the options the host sets: any other could lift a library's own limits (KaTeX's maxExpand).
const convertSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mermaid'),
    source: z.string(),
    at: z.string().min(1),
    options: z.strictObject({ bg: z.string(), fg: z.string(), muted: z.string(), accent: z.string(), transparent: z.boolean() }),
  }),
  z.object({ kind: z.literal('math'), source: z.string(), at: z.string().min(1), options: z.strictObject({ displayMode: z.boolean(), throwOnError: z.boolean() }) }),
])

/** The page's content from the library its kind names, run with the host's options. */
async function converted(convert: z.infer<typeof convertSchema>): Promise<string> {
  if (convert.kind === 'math') return `<style>${inlinedKatexCss()}</style>${katex.renderToString(convert.source, convert.options)}`
  // Native ESM import from the CommonJS container.
  const { renderMermaidSVG } = await import('beautiful-mermaid')
  // The embedded <style> pulls fonts from Google, which the offline render cannot reach.
  return renderMermaidSVG(convert.source, convert.options).replace(/@import url\([^)]*\);/g, '')
}

const renderRequestSchema = z.object({
  html: z.string(),
  scripts: z.boolean(),
  viewport: z.object({ width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096) }),
  deviceScaleFactor: z.number().positive().max(3),
  colorScheme: z.enum(['light', 'dark']),
  fit: z.boolean(),
  convert: convertSchema.optional(),
}).refine(({ html, convert }) => !convert || html.split(convert.at).length === 2, 'A page to convert into holds its marker exactly once')

/** POST /render - the host's page as PNG bytes, with a library's output put in at the marker the host names. */
export function registerRenderRoute(app: Hono): void {
  app.post('/render', async (c) => {
    const parsed = renderRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const { convert, ...shot } = parsed.data
    let html = shot.html
    if (convert) {
      try {
        const content = await converted(convert)
        html = html.replace(convert.at, () => content)
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 422)
      }
    }
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'render-'))
    try {
      const png = path.join(dir, 'visual.png')
      const { written, error } = await rasterizeHtml([{ ...shot, html, path: png }], c.req.raw.signal)
      if (!written.length) return c.json({ error: error ?? 'Nothing rendered' }, 500)
      c.header('Content-Type', 'image/png')
      return c.body(await fs.promises.readFile(png))
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })
}
