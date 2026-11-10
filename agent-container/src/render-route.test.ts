import * as fs from 'fs'
import * as path from 'path'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HTML_PREVIEW_CSP } from './html-preview'
import type { RasterizeHtmlResult, Shot } from './rasterize-html'

const rasterizeMock = vi.hoisted(() => vi.fn<(shots: Shot[]) => Promise<RasterizeHtmlResult>>())
vi.mock('./rasterize-html', () => ({ rasterizeHtml: rasterizeMock }))

const { registerRenderRoute, MERMAID_THEME, HTML_THEME_TOKENS } = await import('./render-route')

const PNG = Buffer.from('png-bytes')

function render(kind: string, source: string) {
  const app = new Hono()
  registerRenderRoute(app)
  return app.request('/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, source }) })
}

describe('POST /render', () => {
  beforeEach(() => {
    rasterizeMock.mockReset()
    rasterizeMock.mockImplementation(async ([shot]) => {
      await fs.promises.writeFile(shot.path, PNG)
      return { written: [shot.path], error: null }
    })
  })

  it('draws each kind from its own offline document, running scripts only for html', async () => {
    const cases = [
      { kind: 'mermaid', source: 'flowchart LR\n  A --> B', document: /<svg[\s\S]*<\/svg>/, scripts: false },
      { kind: 'math', source: 'E = mc^2', document: /src:url\(data:font\/woff2;base64,[\s\S]*class="katex"/, scripts: false },
      { kind: 'html', source: '<p>hi</p>', document: /<p>hi<\/p>/, scripts: true },
    ]
    for (const { kind, source, document, scripts } of cases) {
      const response = await render(kind, source)
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('image/png')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
      const [shot] = rasterizeMock.mock.lastCall![0]
      if (!('html' in shot)) throw new Error('expected a document shot')
      expect(shot.html).toMatch(document)
      expect(shot.html).not.toContain('@import url(')
      expect(shot).toMatchObject({ scripts, fit: true, deviceScaleFactor: 2, colorScheme: 'light' })
    }
    expect(rasterizeMock.mock.lastCall![0][0]).toMatchObject({ html: expect.stringContaining(HTML_PREVIEW_CSP) })
  })

  it('answers an error for a mermaid source with an invalid header, without drawing it', async () => {
    const response = await render('mermaid', 'not a diagram\n  A --> B')
    expect(response.status).toBe(422)
    expect(rasterizeMock).not.toHaveBeenCalled()
  })
})

describe('the light theme copied from the app', () => {
  // The app's light theme: the declarations of the first `:root` block in its stylesheet.
  const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const root = css.match(/:root\s*{([^}]*)}/)?.[1] ?? ''
  const app = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))

  it('still matches the app\'s colours in the diagram theme', () => {
    expect(MERMAID_THEME).toMatchObject({
      bg: `hsl(${app.background})`, fg: `hsl(${app.foreground})`, muted: `hsl(${app['muted-foreground']})`, accent: `hsl(${app.brand})`,
    })
  })

  it('still matches the app\'s tokens in the html preview theme', () => {
    for (const token of HTML_THEME_TOKENS.split(';')) {
      const [name, value] = token.split(':')
      expect([name, value]).toEqual([name, app[name.slice(2)]])
    }
  })
})
