import { describe, expect, it, vi } from 'vitest'
import { captureRegion } from './capture-region'

function contents(options: { zoom?: number; image?: { isEmpty: () => boolean; toPNG: () => Uint8Array } | Promise<never> } = {}) {
  const image = options.image ?? { isEmpty: () => false, toPNG: () => new Uint8Array([137, 80, 78, 71]) }
  return {
    getZoomFactor: vi.fn(() => options.zoom ?? 1),
    capturePage: vi.fn(() => (image instanceof Promise ? image : Promise.resolve(image))),
  }
}

describe('captureRegion', () => {
  it('captures the region, scaled from CSS pixels by the page zoom', async () => {
    const page = contents({ zoom: 1.25 })
    const png = await captureRegion(page as never, { x: 10.2, y: 20, width: 300, height: 200.4 })
    expect(png).toEqual(new Uint8Array([137, 80, 78, 71]))
    expect(page.capturePage).toHaveBeenCalledWith({ x: 13, y: 25, width: 375, height: 251 })
  })

  it('refuses a malformed region without capturing', async () => {
    const page = contents()
    for (const rect of [null, {}, { x: -1, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: Infinity, height: 1 }]) {
      expect(await captureRegion(page as never, rect)).toBeNull()
    }
    expect(page.capturePage).not.toHaveBeenCalled()
  })

  it('gives up on an empty image, a failure, or a capture past its budget', async () => {
    expect(await captureRegion(contents({ image: { isEmpty: () => true, toPNG: () => new Uint8Array() } }) as never, { x: 0, y: 0, width: 1, height: 1 })).toBeNull()
    expect(await captureRegion(contents({ image: Promise.reject(new Error('gone')) }) as never, { x: 0, y: 0, width: 1, height: 1 })).toBeNull()
    vi.useFakeTimers()
    try {
      const pending = captureRegion(contents({ image: new Promise<never>(() => {}) }) as never, { x: 0, y: 0, width: 1, height: 1 }, 50)
      await vi.advanceTimersByTimeAsync(50)
      expect(await pending).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
