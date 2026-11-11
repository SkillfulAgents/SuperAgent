import * as fs from 'fs'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RasterizeHtmlResult, Shot } from './rasterize-html'

const rasterizeMock = vi.hoisted(() => vi.fn<(shots: Shot[]) => Promise<RasterizeHtmlResult>>())
vi.mock('./rasterize-html', () => ({ rasterizeHtml: rasterizeMock }))

const { registerRenderRoute } = await import('./render-route')

const PNG = Buffer.from('png-bytes')

const PAGE = { scripts: false, viewport: { width: 720, height: 400 }, deviceScaleFactor: 2, colorScheme: 'light', fit: true }
const AT = '<!--here-->'
const FITTED = `<html><body>${AT}</body></html>`

function render(request: Record<string, unknown>) {
  const app = new Hono()
  registerRenderRoute(app)
  return app.request('/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...PAGE, ...request }) })
}

describe('POST /render', () => {
  beforeEach(() => {
    rasterizeMock.mockReset()
    rasterizeMock.mockImplementation(async ([shot]) => {
      await fs.promises.writeFile(shot.path, PNG)
      return { written: [shot.path], error: null }
    })
  })

  it('draws the host\'s page as it asks, with no converter', async () => {
    const response = await render({ html: '<p>hi</p>', scripts: true })

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
    expect(rasterizeMock.mock.lastCall![0][0]).toMatchObject({ ...PAGE, html: '<p>hi</p>', scripts: true })
  })

  it('puts each converter\'s output at the marker the host names', async () => {
    const cases = [
      { convert: { kind: 'mermaid', source: 'flowchart LR\n  A --> B', at: AT, options: { bg: '#fff', fg: '#000', muted: '#666', accent: '#09f', transparent: true } }, output: /<body><svg[\s\S]*<\/svg><\/body>/ },
      { convert: { kind: 'math', source: 'E = mc^2', at: AT, options: { displayMode: true, throwOnError: true } }, output: /<body><style>[\s\S]*src:url\(data:font\/woff2;base64,[\s\S]*class="katex/ },
    ]
    for (const { convert, output } of cases) {
      expect((await render({ html: FITTED, convert })).status).toBe(200)
      const [shot] = rasterizeMock.mock.lastCall![0]
      if (!('html' in shot)) throw new Error('expected a document shot')
      expect(shot.html).toMatch(output)
      expect(shot.html).not.toContain('@import url(')
    }
  })

  it('answers an error for a source its converter refuses, without drawing it', async () => {
    const response = await render({ html: FITTED, convert: { kind: 'math', source: '\\frac{', at: AT, options: { displayMode: true, throwOnError: true } } })
    expect(response.status).toBe(422)
    expect(rasterizeMock).not.toHaveBeenCalled()
  })

  it('refuses a request that is not a page, options a converter does not take, or a page with no single place for the content', async () => {
    const math = { kind: 'math', source: 'x', at: AT, options: { displayMode: true, throwOnError: true } }
    for (const request of [
      { html: undefined, kind: 'mermaid', source: 'x' },
      { html: FITTED, convert: { ...math, options: { ...math.options, maxExpand: 'Infinity' } } },
      { html: '<p>no marker</p>', convert: math },
      { html: FITTED + FITTED, convert: math },
      { html: '<p>x</p>', viewport: { width: 100_000, height: 400 } },
    ]) expect((await render(request)).status).toBe(400)
    expect(rasterizeMock).not.toHaveBeenCalled()
  })
})
