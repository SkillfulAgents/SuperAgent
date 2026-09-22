import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  BROWSER_USE_GUIDANCE_HINT,
  createBrowserTools,
  stripAnsi,
  extractScreenshotPath,
} from './browser'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello')
  })

  it('removes multiple color codes', () => {
    expect(stripAnsi('\x1b[32m✓\x1b[0m Screenshot saved to \x1b[32m/path/to/file.png\x1b[0m')).toBe(
      '✓ Screenshot saved to /path/to/file.png'
    )
  })

  it('handles strings with no ANSI codes', () => {
    expect(stripAnsi('plain text')).toBe('plain text')
  })

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('')
  })

  it('removes bold/underline/etc codes', () => {
    expect(stripAnsi('\x1b[1mbold\x1b[0m \x1b[4munderline\x1b[0m')).toBe('bold underline')
  })
})

describe('extractScreenshotPath', () => {
  it('extracts path from ANSI-formatted agent-browser output', () => {
    const output = '\x1b[32m✓\x1b[0m Screenshot saved to \x1b[32m/home/claude/.agent-browser/tmp/screenshots/screenshot-2026-02-18T23-07-35-662Z-xnz64i.png\x1b[0m'
    expect(extractScreenshotPath(output)).toBe(
      '/home/claude/.agent-browser/tmp/screenshots/screenshot-2026-02-18T23-07-35-662Z-xnz64i.png'
    )
  })

  it('extracts path from plain text output', () => {
    const output = '✓ Screenshot saved to /tmp/screenshot.png'
    expect(extractScreenshotPath(output)).toBe('/tmp/screenshot.png')
  })

  it('extracts .jpg path', () => {
    const output = 'Screenshot saved to /tmp/screenshot.jpg'
    expect(extractScreenshotPath(output)).toBe('/tmp/screenshot.jpg')
  })

  it('extracts .jpeg path', () => {
    const output = 'Screenshot saved to /tmp/screenshot.jpeg'
    expect(extractScreenshotPath(output)).toBe('/tmp/screenshot.jpeg')
  })

  it('returns cleaned string if no path found', () => {
    expect(extractScreenshotPath('no path here')).toBe('no path here')
  })

  it('returns cleaned string for empty input', () => {
    expect(extractScreenshotPath('')).toBe('')
  })

  it('handles path with spaces in surrounding text but not in path', () => {
    const output = '\x1b[32m✓\x1b[0m Saved to \x1b[32m/var/data/img.png\x1b[0m done'
    expect(extractScreenshotPath(output)).toBe('/var/data/img.png')
  })
})

describe('browser_open location', () => {
  it('forwards an explicit container location to the browser endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      location: 'container',
      switchedFrom: 'host',
      launched: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const openTool = createBrowserTools(() => 'session-1')
      .find(candidate => candidate.name === 'browser_open') as any
    const result = await openTool.handler({
      url: 'http://localhost:5173',
      location: 'container',
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [, request] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(request?.body))).toMatchObject({
      sessionId: 'session-1',
      url: 'http://localhost:5173',
      location: 'container',
    })
    expect(result.content[0].text).toContain('bundled Chromium inside the agent container')
    expect(result.content[0].text).toContain('previous host browser was closed')
    expect(result.content[0].text).toContain(BROWSER_USE_GUIDANCE_HINT)
  })

  it('reports the landing page — final URL, redirect, HTTP status — when the server probed it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      location: 'host',
      page: { url: 'https://app.com/login?next=%2Fdashboard', title: 'Sign in', readyState: 'complete', httpStatus: 200, contentType: 'text/html' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const openTool = createBrowserTools(() => 'session-4')
      .find(candidate => candidate.name === 'browser_open') as any
    const result = await openTool.handler({ url: 'https://app.com/dashboard' })

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('Loaded "Sign in" at https://app.com/login?next=%2Fdashboard (redirected from https://app.com/dashboard) · HTTP 200')
    expect(result.content[0].text).not.toContain('navigating to')
  })

  it('reports an HTTP error status and a raw document as facts, with the page text, without making the open an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      location: 'host',
      page: { url: 'https://drinkolipop.com/', title: '', readyState: 'complete', httpStatus: 429, contentType: 'text/plain', preview: 'local_rate_limited' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const openTool = createBrowserTools(() => 'session-5')
      .find(candidate => candidate.name === 'browser_open') as any
    const result = await openTool.handler({ url: 'https://drinkolipop.com' })

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('Loaded an untitled page at https://drinkolipop.com/ · HTTP 429')
    expect(result.content[0].text).not.toContain('⚠ HTTP')
    expect(result.content[0].text).toContain('⚠ raw text/plain document')
    expect(result.content[0].text).toContain('Page text: "local_rate_limited"')
  })

  it('is not an error for an error status on a page with a real tree (an SPA served from a 404 fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      location: 'host',
      page: { url: 'https://app.com/orders/123', title: 'Orders', readyState: 'complete', httpStatus: 404, contentType: 'text/html', interactive: 61 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const openTool = createBrowserTools(() => 'session-5b')
      .find(candidate => candidate.name === 'browser_open') as any
    const result = await openTool.handler({ url: 'https://app.com/orders/123' })

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('Loaded "Orders" at https://app.com/orders/123 · HTTP 404')
    expect(result.content[0].text).not.toContain('⚠')
  })

  it('falls back to intent-shaped text, and says so, when the probe could not run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      location: 'host',
      page: { url: '' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const openTool = createBrowserTools(() => 'session-6')
      .find(candidate => candidate.name === 'browser_open') as any
    const result = await openTool.handler({ url: 'https://example.com' })

    expect(result.content[0].text).toContain('navigating to https://example.com')
    expect(result.content[0].text).toContain('landing page could not be read')
  })

  it('omits location so the server can preserve the current browser', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      location: 'container',
      launched: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const openTool = createBrowserTools(() => 'session-2')
      .find(candidate => candidate.name === 'browser_open') as any
    const result = await openTool.handler({ url: 'https://example.com' })

    const [, request] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(request?.body))).not.toHaveProperty('location')
    expect(result.content[0].text).toContain('/opt/gamut/docs/browser-use.md')
  })

  it('omits the browser guide hint when switching to an existing tab', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      location: 'container',
      switchedToExisting: true,
      tabId: 't2',
      url: 'https://example.com',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    const openTool = createBrowserTools(() => 'session-3')
      .find(candidate => candidate.name === 'browser_open') as any
    const result = await openTool.handler({ url: 'https://example.com' })

    expect(result.content[0].text).not.toContain(BROWSER_USE_GUIDANCE_HINT)
  })
})

describe('browser guide hint frequency', () => {
  afterEach(() => vi.unstubAllGlobals())

  const open = async (body: Record<string, unknown>) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const openTool = createBrowserTools(() => 'session-h').find(t => t.name === 'browser_open') as any
    const result = await openTool.handler({ url: 'https://example.com/a' })
    return String(result.content[0].text)
  }
  const page = { url: 'https://example.com/a', title: 'A', readyState: 'complete', httpStatus: 200, contentType: 'text/html' }

  it('attaches the hint when the open launched a browser', async () => {
    expect(await open({ success: true, location: 'host', page, launched: true })).toContain(BROWSER_USE_GUIDANCE_HINT)
    expect(await open({ success: true, location: 'host', launched: true })).toContain(BROWSER_USE_GUIDANCE_HINT)
  })

  it('omits the hint for an open inside an already-running browser', async () => {
    expect(await open({ success: true, location: 'host', page })).not.toContain(BROWSER_USE_GUIDANCE_HINT)
    expect(await open({ success: true, location: 'host', page, launched: false })).not.toContain(BROWSER_USE_GUIDANCE_HINT)
    expect(await open({ success: true, location: 'host' })).not.toContain(BROWSER_USE_GUIDANCE_HINT)
  })
})

describe('browser_eval return note', () => {
  afterEach(() => vi.unstubAllGlobals())

  const evalWith = async (output: string, wrapped: boolean) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, output, wrapped }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const evalTool = createBrowserTools(() => 'session-e').find(t => t.name === 'browser_eval') as any
    const result = await evalTool.handler({ script: 'ignored' })
    return String(result.content[0].text)
  }

  it('does not attach the note when a wrapped script returned a value', async () => {
    const text = await evalWith('{"rows":18}', true)
    expect(text).toContain('{"rows":18}')
    expect(text).not.toContain('add `return`')
  })

  it('does not attach the note to falsy-but-real values', async () => {
    for (const out of ['0', 'false', '""', '{}', '[]']) {
      expect(await evalWith(out, true)).not.toContain('add `return`')
    }
  })

  it('attaches the note only when a wrapped body produced null or nothing', async () => {
    expect(await evalWith('null', true)).toContain('add `return`')
    expect(await evalWith('', true)).toContain('add `return`')
  })

  it('never attaches the note to an unwrapped expression', async () => {
    expect(await evalWith('null', false)).not.toContain('add `return`')
    expect(await evalWith('', false)).toBe('(no output)')
  })
})

describe('browser_run empty output', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports "(no output)" instead of a success acknowledgment when the CLI printed nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, output: '' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const runTool = createBrowserTools(() => 'session-r').find(t => t.name === 'browser_run') as any
    const result = await runTool.handler({ command: 'errors' })
    expect(String(result.content[0].text)).toMatch(/^\(no output\)/)
    expect(String(result.content[0].text)).not.toContain('Command executed')
  })

  it('passes real output through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, output: '[error] TypeError: x is null' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const runTool = createBrowserTools(() => 'session-r').find(t => t.name === 'browser_run') as any
    const result = await runTool.handler({ command: 'errors' })
    expect(String(result.content[0].text)).toMatch(/^\[error\] TypeError/)
  })
})

describe('browser_wait result', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports the measured elapsed time, not a constant "satisfied"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, elapsedMs: 4 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const waitTool = createBrowserTools(() => 'session-w').find(t => t.name === 'browser_wait') as any
    const result = await waitTool.handler({ for: 'body' })
    expect(result.content[0].text).toBe('Selector "body" matched after 4 ms.')
  })

  it('refuses Playwright syntax before calling the server', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const waitTool = createBrowserTools(() => 'session-w').find(t => t.name === 'browser_wait') as any
    const result = await waitTool.handler({ for: 'text=Trigger' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('--text')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says a load state was not reached instead of reporting success silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, elapsedMs: 25010, timedOut: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const waitTool = createBrowserTools(() => 'session-w').find(t => t.name === 'browser_wait') as any
    const result = await waitTool.handler({ for: 'networkidle' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe('Load state "networkidle" was not reached within 25010 ms.')
  })
})

describe('browser_wait result carries the page URL', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows where the page is after the wait, so a navigation that finished meanwhile is visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, elapsedMs: 900, url: 'https://a.com/dashboard' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const waitTool = createBrowserTools(() => 'session-w').find(t => t.name === 'browser_wait') as any
    const result = await waitTool.handler({ for: '#dash' })
    expect(result.content[0].text).toBe('Selector "#dash" matched after 900 ms. Page: https://a.com/dashboard')
  })
})

describe('browser_get_state coherence', () => {
  afterEach(() => vi.unstubAllGlobals())

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('takes the URL from the snapshot it shows, and never calls get url', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      if (String(url).endsWith('/browser/snapshot')) {
        return json({
          snapshot: '[page] https://b.com/results · "Results" · HTTP 200 · complete · 3 refs\n\n- button "Go" [ref=e1]',
          page: { url: 'https://b.com/results', title: 'Results', readyState: 'complete', httpStatus: 200, contentType: 'text/html' },
          tabCount: 1,
        })
      }
      return json({ output: 'Screenshot saved to: /nonexistent/shot.png' })
    }))
    const tool = createBrowserTools(() => 's').find(t => t.name === 'browser_get_state') as any
    const result = await tool.handler({})
    const text = String(result.content.find((c: any) => c.type === 'text').text)
    expect(text).toContain('**Current URL:** https://b.com/results')
    expect(text).toContain('**Accessibility Snapshot:**')
    expect(calls.some(u => u.endsWith('/browser/run'))).toBe(false)
    expect(calls.indexOf(calls.find(u => u.endsWith('/browser/snapshot'))!)).toBeLessThan(calls.indexOf(calls.find(u => u.endsWith('/browser/screenshot'))!))
    expect(result.isError).toBeUndefined()
  })

  it('collapses one cause that failed every leg into one error line and marks the result an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: '✗ Auto-launch failed: CDP WebSocket connect failed: HTTP error: 410 Gone' }, 500)))
    const tool = createBrowserTools(() => 's').find(t => t.name === 'browser_get_state') as any
    const result = await tool.handler({})
    const text = String(result.content[0].text)
    expect(text.match(/410 Gone/g)).toHaveLength(1)
    expect(text).toContain('**Error (snapshot and screenshot):**')
    expect(text).not.toContain('Current URL')
    expect(result.isError).toBe(true)
  })

  it('keeps a partial failure as a section error without marking the whole result an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/browser/snapshot')) {
        return json({ snapshot: '[page] https://b.com/ · "B" · HTTP 200 · complete · 1 refs\n\n- link "x" [ref=e1]', page: { url: 'https://b.com/', title: 'B', readyState: 'complete', httpStatus: 200, contentType: 'text/html' }, tabCount: 1 })
      }
      return json({ error: 'screenshot timed out' }, 500)
    }))
    const tool = createBrowserTools(() => 's').find(t => t.name === 'browser_get_state') as any
    const result = await tool.handler({})
    const text = String(result.content[0].text)
    expect(text).toContain('**Error (screenshot):** screenshot timed out')
    expect(text).toContain('**Current URL:** https://b.com/')
    expect(result.isError).toBeUndefined()
  })

  it('omits the screenshot leg entirely when screenshot=false, so a single failure is total', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Browser is not active' }, 400)))
    const tool = createBrowserTools(() => 's').find(t => t.name === 'browser_get_state') as any
    const result = await tool.handler({ screenshot: false })
    expect(String(result.content[0].text)).toBe('**Error (snapshot):** Browser is not active')
    expect(result.isError).toBe(true)
  })
})

describe('browser_get_state screenshot delivery', () => {
  afterEach(() => vi.unstubAllGlobals())

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('counts an unreadable screenshot file as a failed leg, so snapshot failure + unreadable file is a total failure', async () => {
    // review: snapshot failed and the screenshot file could not be read/resized — nothing delivered, isError absent
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/browser/snapshot')) return json({ error: 'Browser is not active' }, 400)
      return json({ output: 'Screenshot saved to: /nonexistent/dir/shot.png' })
    }))
    const tool = createBrowserTools(() => 's').find(t => t.name === 'browser_get_state') as any
    const result = await tool.handler({})
    const text = String(result.content[0].text)
    expect(result.content.some((c: any) => c.type === 'image')).toBe(false)
    expect(text).toContain('**Error (snapshot):** Browser is not active')
    expect(text).toContain('**Error (screenshot):** screenshot file could not be read: /nonexistent/dir/shot.png')
    expect(text).not.toContain('**Screenshot:**')
    expect(result.isError).toBe(true)
  })

  it('treats a missing screenshot path as a failed leg too', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/browser/snapshot')) return json({ snapshot: '[page] https://b.com/ · "B" · HTTP 200 · complete · 1 refs\n- link "x" [ref=e1]', page: { url: 'https://b.com/', title: 'B', readyState: 'complete', httpStatus: 200, contentType: 'text/html' }, tabCount: 1 })
      return json({ output: '' })
    }))
    const tool = createBrowserTools(() => 's').find(t => t.name === 'browser_get_state') as any
    const result = await tool.handler({})
    expect(String(result.content[0].text)).toContain('**Error (screenshot):** no screenshot path returned')
    expect(result.isError).toBeUndefined()
  })
})
