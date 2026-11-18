import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const launchMock = vi.hoisted(() => vi.fn())

// launchMock resolves to the fake browser; the server around it closes it, and connecting hands it back.
vi.mock('playwright-core', () => ({
  chromium: {
    launchServer: async (...args: unknown[]) => {
      const browser = await launchMock(...args)
      return { wsEndpoint: () => browser, close: () => browser.close(), kill: () => browser.kill?.() }
    },
    connect: async (browser: unknown) => browser,
  },
}))
vi.mock('./chromium-executable', () => ({ resolveChromiumExecutable: () => '/fake/chromium' }))

const { rasterizeHtml } = await import('./rasterize-html')

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('rasterizeHtml', () => {
  afterEach(() => {
    vi.useRealTimers()
    launchMock.mockReset()
  })

  it('starts a second call only after the first settles, so two callers never run two browsers', async () => {
    const browser = { newContext: vi.fn(), close: vi.fn(async () => {}) }
    let finishLaunch = () => {}
    launchMock.mockImplementationOnce(() => new Promise((resolve) => { finishLaunch = () => resolve(browser) }))
    launchMock.mockResolvedValueOnce(browser)

    const first = rasterizeHtml([])
    const second = rasterizeHtml([])
    await flush()
    expect(launchMock).toHaveBeenCalledTimes(1)

    finishLaunch()
    await first
    await second
    expect(launchMock).toHaveBeenCalledTimes(2)
  })

  it('admits the next call only once the first browser has closed, even after the first caller timed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let finishLaunch: (browser: unknown) => void = () => {}
    let finishClose = () => {}
    const slow = { newContext: vi.fn(), close: vi.fn(() => new Promise<void>((resolve) => { finishClose = resolve })) }
    launchMock.mockImplementationOnce(() => new Promise((resolve) => { finishLaunch = resolve }))
    launchMock.mockResolvedValueOnce({ newContext: vi.fn(), close: vi.fn(async () => {}) })

    const first = rasterizeHtml([])
    const second = rasterizeHtml([])
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await first).error).toMatch(/exceeded/)

    finishLaunch(slow)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(slow.close).toHaveBeenCalled()
    expect(launchMock).toHaveBeenCalledTimes(1)

    finishClose()
    await second
    expect(launchMock).toHaveBeenCalledTimes(2)
  })

  it('kills a browser whose close hangs past the raster limit, so the calls behind it still run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hung = { newContext: vi.fn(), close: vi.fn(() => new Promise<void>(() => {})), kill: vi.fn(async () => {}) }
    launchMock.mockResolvedValueOnce(hung)
    launchMock.mockResolvedValueOnce({ newContext: vi.fn(), close: vi.fn(async () => {}) })

    const first = rasterizeHtml([])
    const second = rasterizeHtml([])
    await vi.advanceTimersByTimeAsync(34_000)
    expect((await first).error).toMatch(/exceeded/)
    expect(hung.kill).not.toHaveBeenCalled()
    expect(launchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await second
    expect(hung.kill).toHaveBeenCalled()
    expect(launchMock).toHaveBeenCalledTimes(2)
  })

  it('bounds the kill too, so a kill that hangs still lets the next call run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hung = { newContext: vi.fn(), close: vi.fn(() => new Promise<void>(() => {})), kill: vi.fn(() => new Promise<void>(() => {})) }
    launchMock.mockResolvedValueOnce(hung)
    launchMock.mockResolvedValueOnce({ newContext: vi.fn(), close: vi.fn(async () => {}) })

    void rasterizeHtml([])
    const second = rasterizeHtml([])
    await vi.advanceTimersByTimeAsync(40_000)
    await second
    expect(hung.kill).toHaveBeenCalled()
    expect(launchMock).toHaveBeenCalledTimes(2)
  })

  it('answers a caller that gives up while still queued at once, and skips its turn', async () => {
    let finishClose = () => {}
    const first = { newContext: vi.fn(), close: vi.fn(() => new Promise<void>((resolve) => { finishClose = resolve })) }
    launchMock.mockResolvedValueOnce(first)
    const controller = new AbortController()

    void rasterizeHtml([])
    const queued = rasterizeHtml([], controller.signal)
    await flush()
    controller.abort()

    expect((await queued).error).toBe('Abandoned by the caller')
    finishClose()
    await flush()
    await flush()
    expect(launchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the browser\'s control socket on the loopback interface', async () => {
    launchMock.mockResolvedValueOnce({ newContext: vi.fn(), close: vi.fn(async () => {}) })
    await rasterizeHtml([])
    expect(launchMock.mock.calls[0][0]).toMatchObject({ host: '127.0.0.1' })
  })

  it('stops a render, and closes its browser, as soon as its caller gives up', async () => {
    // A page that loads until its browser closes, as a real one does.
    let closePage: (error: Error) => void = () => {}
    const page = { setContent: vi.fn(() => new Promise<void>((_, reject) => { closePage = reject })) }
    const browser = { newContext: vi.fn(async () => ({ newPage: async () => page, close: async () => {} })), close: vi.fn(async () => closePage(new Error('Browser closed'))) }
    launchMock.mockResolvedValueOnce(browser)
    const controller = new AbortController()

    const pending = rasterizeHtml([{ html: '<p>x</p>', viewport: { width: 10, height: 10 }, deviceScaleFactor: 1, colorScheme: 'light', path: '/tmp/never.png' }], controller.signal)
    await flush()
    await flush()
    controller.abort()

    expect((await pending).error).toBe('Abandoned by the caller')
    expect(browser.close).toHaveBeenCalled()
  })

  it('opens a page by URL with its scripts and the network, and renders a document offline', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raster-'))
    const page = {
      goto: vi.fn(async () => {}),
      setContent: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      screenshot: vi.fn(async ({ path: out }: { path: string }) => fs.writeFileSync(out, 'png')),
    }
    const browser = { newContext: vi.fn(async () => ({ newPage: async () => page, close: async () => {} })), close: vi.fn(async () => {}) }
    launchMock.mockResolvedValueOnce(browser)
    const common = { viewport: { width: 10, height: 10 }, deviceScaleFactor: 1, colorScheme: 'light' as const }

    try {
      const { written } = await rasterizeHtml([
        { url: 'http://localhost:4000/', scripts: true, path: path.join(dir, 'page.png'), ...common },
        { html: '<p>x</p>', path: path.join(dir, 'doc.png'), ...common },
      ])

      expect(written).toHaveLength(2)
      expect(page.goto).toHaveBeenCalledWith('http://localhost:4000/', expect.anything())
      expect(page.setContent).toHaveBeenCalledWith('<p>x</p>', expect.anything())
      expect(browser.newContext.mock.calls.map(([options]) => [options.javaScriptEnabled, options.offline])).toEqual([[true, false], [false, true]])
      // A page loading from its server gets longer to settle than a document carrying its data.
      expect(page.waitForTimeout.mock.calls).toEqual([[500], [150]])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips a call whose caller gave up before it was admitted', async () => {
    const controller = new AbortController()
    controller.abort()

    expect((await rasterizeHtml([], controller.signal)).written).toEqual([])
    expect(launchMock).not.toHaveBeenCalled()
  })
})
