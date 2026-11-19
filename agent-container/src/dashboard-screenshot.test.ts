import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RasterizeHtmlResult, Shot } from './rasterize-html'

const rasterizeMock = vi.hoisted(() => vi.fn<(shots: Shot[], signal?: AbortSignal) => Promise<RasterizeHtmlResult>>())
vi.mock('./rasterize-html', () => ({ rasterizeHtml: rasterizeMock }))

const { captureDashboardScreenshot } = await import('./dashboard-screenshot')

describe('captureDashboardScreenshot', () => {
  beforeEach(() => { rasterizeMock.mockReset() })

  it('captures the page by URL with its scripts, at the dashboard size, under its own time limit', async () => {
    rasterizeMock.mockImplementation(async ([shot]) => ({ written: [shot.path], error: null }))

    expect(await captureDashboardScreenshot('http://127.0.0.1:4000/', '/tmp/dash/shot.png')).toEqual({ ok: true, path: '/tmp/dash/shot.png' })
    const [[shot], signal] = rasterizeMock.mock.lastCall!
    expect(shot).toEqual({ url: 'http://127.0.0.1:4000/', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light', scripts: true, path: '/tmp/dash/shot.png' })
    expect(signal?.aborted).toBe(false)
  })

  it('reports why nothing was captured', async () => {
    rasterizeMock.mockResolvedValue({ written: [], error: 'Screenshot capture exceeded 15000ms' })

    expect(await captureDashboardScreenshot('http://127.0.0.1:4000/', '/tmp/dash/shot.png')).toEqual({ ok: false, reason: 'Screenshot capture exceeded 15000ms' })
  })
})
