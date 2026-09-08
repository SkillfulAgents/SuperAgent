import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const launchMock = vi.hoisted(() => vi.fn())

vi.mock('playwright-core', () => ({ chromium: { launch: (...args: unknown[]) => launchMock(...args) } }))
vi.mock('./dashboard-screenshot', () => ({ resolveChromiumExecutable: () => '/fake/chromium' }))

const { rasterizeWidget } = await import('./widget-rasterizer')

interface FakeBrowser {
  newContext: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

/**
 * A browser whose pages behave as `page` says. `screenshot` writes the file it
 * is given, because the rasterizer renames it afterwards.
 */
function fakeBrowser(page: Record<string, unknown>): FakeBrowser {
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  }
  return {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {}),
  }
}

function workingPage() {
  return {
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    screenshot: vi.fn(async ({ path: file }: { path: string }) => {
      await fs.promises.writeFile(file, 'png')
    }),
  }
}

describe('rasterizeWidget', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raster-'))
    fs.writeFileSync(path.join(dir, 'widget.html'), '<html><body>hi</body></html>')
    launchMock.mockReset()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('renders every family, scheme and scale from one browser', async () => {
    const browser = fakeBrowser(workingPage())
    launchMock.mockResolvedValue(browser)

    const result = await rasterizeWidget(dir)

    expect(result.error).toBeNull()
    expect(result.rendered.sort()).toEqual([
      'medium-dark@2x', 'medium-dark@3x', 'medium-light@2x', 'medium-light@3x',
      'small-dark@2x', 'small-dark@3x', 'small-light@2x', 'small-light@3x',
    ])
    expect(launchMock).toHaveBeenCalledTimes(1)
    expect(browser.close).toHaveBeenCalled()
    // Only the renamed files survive; no half-written .tmp is left behind.
    expect(fs.readdirSync(path.join(dir, 'snapshots')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a hung page ends the batch and closes the browser, rather than leaving it rendering', async () => {
    vi.useFakeTimers()
    const page = workingPage()
    // The first navigation never settles — the failure the timeout exists for.
    page.goto = vi.fn(() => new Promise<void>(() => {}))
    const browser = fakeBrowser(page)
    launchMock.mockResolvedValue(browser)

    const pending = rasterizeWidget(dir)
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await pending

    expect(result.error).toMatch(/exceeded/)
    expect(result.rendered).toEqual([])
    // Closing the browser is what actually stops the work: without it the
    // launch outlives the refresh that asked for it.
    expect(browser.close).toHaveBeenCalled()
    // And the batch does not carry on rendering the remaining families.
    const contextsAtTimeout = browser.newContext.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(browser.newContext.mock.calls.length).toBe(contextsAtTimeout)
  })

  it('reports a missing widget.html without launching anything', async () => {
    fs.rmSync(path.join(dir, 'widget.html'))

    const result = await rasterizeWidget(dir)

    expect(result).toEqual({ rendered: [], error: 'widget.html is missing' })
    expect(launchMock).not.toHaveBeenCalled()
  })
})
