import { afterEach, describe, it, expect, vi } from 'vitest'
import { createBrowserTools, stripAnsi, extractScreenshotPath } from './browser'

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
  })

  it('keeps configured provider behavior as the backwards-compatible default', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      location: 'host',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const openTool = createBrowserTools(() => 'session-2')
      .find(candidate => candidate.name === 'browser_open') as any
    await openTool.handler({ url: 'https://example.com' })

    const [, request] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(request?.body)).location).toBe('configured')
  })
})
