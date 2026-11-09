import { describe, it, expect, vi, afterEach } from 'vitest'

const launchMock = vi.hoisted(() => vi.fn())

vi.mock('playwright-core', () => ({ chromium: { launch: (...args: unknown[]) => launchMock(...args) } }))
vi.mock('./dashboard-screenshot', () => ({ resolveChromiumExecutable: () => '/fake/chromium' }))

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
    await vi.advanceTimersByTimeAsync(60_000)
    expect(slow.close).toHaveBeenCalled()
    expect(launchMock).toHaveBeenCalledTimes(1)

    finishClose()
    await second
    expect(launchMock).toHaveBeenCalledTimes(2)
  })

  it('skips a call whose caller gave up before it was admitted', async () => {
    const controller = new AbortController()
    controller.abort()

    expect((await rasterizeHtml([], controller.signal)).written).toEqual([])
    expect(launchMock).not.toHaveBeenCalled()
  })
})
