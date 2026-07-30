// @vitest-environment jsdom
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import { Halftone } from './halftone'

describe('Halftone animation lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('pauses its animation while the card is offscreen and resumes on re-entry', () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    const disconnectObserver = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
        observe() {}
        unobserve() {}
        disconnect = disconnectObserver
        takeRecords() {
          return []
        }
        root = null
        rootMargin = '0px'
        thresholds = [0]
      }
    )

    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D)

    let nextRaf = 1
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => nextRaf++)
    const cancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    const { unmount } = renderWithProviders(<Halftone motif="flow_3d" />)
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(intersectionCallback).toBeTypeOf('function')

    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)

    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2)

    unmount()
    expect(disconnectObserver).toHaveBeenCalled()
  })

  it('recovers when its first measurement is zero-sized', () => {
    let resizeCallback: ResizeObserverCallback | undefined
    const observe = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback
        }
        observe = observe
        unobserve() {}
        disconnect() {}
      }
    )

    let width = 0
    let height = 0
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
    const setTransform = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform,
    } as unknown as CanvasRenderingContext2D)
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)

    renderWithProviders(<Halftone motif="flow_3d" />)
    expect(observe).toHaveBeenCalledTimes(1)
    expect(setTransform).not.toHaveBeenCalled()
    expect(requestAnimationFrame).not.toHaveBeenCalled()

    width = 240
    height = 120
    act(() => {
      resizeCallback?.([], {} as ResizeObserver)
    })

    expect(setTransform).toHaveBeenCalled()
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
  })
})
