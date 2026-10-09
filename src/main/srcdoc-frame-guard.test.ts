import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import type { WebContents } from 'electron'
import { blockSrcdocFrameNavigation } from './srcdoc-frame-guard'

function navigate(webContents: EventEmitter, details: { url: string; isMainFrame: boolean; frameUrl: string | null }) {
  const preventDefault = vi.fn()
  webContents.emit('will-frame-navigate', {
    url: details.url,
    isMainFrame: details.isMainFrame,
    isSameDocument: false,
    frame: details.frameUrl === null ? null : { url: details.frameUrl },
    preventDefault,
  })
  return preventDefault.mock.calls.length > 0
}

describe('blockSrcdocFrameNavigation', () => {
  const webContents = new EventEmitter()
  blockSrcdocFrameNavigation(webContents as unknown as WebContents)

  it('blocks a srcdoc frame from loading a web page into itself', () => {
    expect(navigate(webContents, { url: 'https://evil.example/c?k=secret', isMainFrame: false, frameUrl: 'about:srcdoc' })).toBe(true)
    expect(navigate(webContents, { url: 'about:blank', isMainFrame: false, frameUrl: 'about:srcdoc' })).toBe(true)
  })

  it('lets a srcdoc frame load a new srcdoc, as on a theme switch', () => {
    expect(navigate(webContents, { url: 'about:srcdoc', isMainFrame: false, frameUrl: 'about:srcdoc' })).toBe(false)
  })

  it('leaves other frames and the main window alone', () => {
    expect(navigate(webContents, { url: 'http://localhost:47891/dashboard', isMainFrame: false, frameUrl: 'http://localhost:47891/' })).toBe(false)
    expect(navigate(webContents, { url: 'about:srcdoc', isMainFrame: false, frameUrl: 'about:blank' })).toBe(false)
    expect(navigate(webContents, { url: 'https://example.com', isMainFrame: true, frameUrl: 'about:srcdoc' })).toBe(false)
  })
})
