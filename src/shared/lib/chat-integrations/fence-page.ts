import { htmlPreviewBodyStyle, htmlPreviewDocument } from '../html-preview'

export type FenceKind = 'mermaid' | 'math' | 'html'

/** What the agent container's POST /render draws: a page, optionally with a library's output put in at `convert.at`. */
export interface RenderRequest {
  html: string
  scripts: boolean
  viewport: { width: number; height: number }
  deviceScaleFactor: number
  colorScheme: 'light'
  fit: boolean
  convert?: { kind: 'mermaid' | 'math'; source: string; at: string; options: Record<string, unknown> }
}

/** Where the container puts a converter's output in the page. */
export const CONVERTED = '<!--superagent:converted-->'

// Content wider than this grows the PNG; an html preview fills it, as it fills the chat column in the app.
const VIEWPORT = { width: 720, height: 400 }

// The app's light theme (src/renderer/globals.css) as values: the page has no access to the app's stylesheet.
export const MERMAID_THEME = { bg: 'hsl(0 0% 100%)', fg: 'hsl(0 0% 3.9%)', muted: 'hsl(0 0% 45.1%)', accent: 'hsl(204 100% 50%)', transparent: true }
export const HTML_THEME_TOKENS =
  '--background:0 0% 100%;--foreground:0 0% 3.9%;--card:0 0% 100%;--card-foreground:0 0% 3.9%;--primary:0 0% 9%;' +
  '--primary-foreground:0 0% 98%;--muted:0 0% 96.1%;--muted-foreground:0 0% 45.1%;--accent:0 0% 96.1%;' +
  '--destructive:0 84.2% 60.2%;--border:0 0% 89.8%;--ring:0 0% 63.9%;--radius:0.5rem;--chart-1:12 76% 61%;' +
  '--chart-2:173 58% 39%;--chart-3:197 37% 24%;--chart-4:43 74% 66%;--chart-5:27 87% 67%'

/** A page whose body shrinks to the converter's output. */
const FITTED_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0}body{width:max-content;padding:16px}</style></head><body>${CONVERTED}</body></html>`

/** The app's html preview page, with the light theme's tokens as values in place of the app's live ones. */
function htmlPage(source: string): string {
  const style =
    `:root{${HTML_THEME_TOKENS}}` +
    htmlPreviewBodyStyle('-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif') +
    'body{padding:16px}'
  return htmlPreviewDocument(source, 'light', `<style>${style}</style>`)
}

/** How a fence is drawn as the app draws it. Scripts run only for html, as only the app's html preview runs them. */
export function fencePage(kind: FenceKind, source: string): RenderRequest {
  const shot: Pick<RenderRequest, 'viewport' | 'deviceScaleFactor' | 'colorScheme' | 'fit'> = { viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light', fit: true }
  if (kind === 'html') return { ...shot, html: htmlPage(source), scripts: true }
  const options = kind === 'mermaid' ? MERMAID_THEME : { displayMode: true, throwOnError: true }
  return { ...shot, html: FITTED_PAGE, scripts: false, convert: { kind, source, at: CONVERTED, options } }
}
