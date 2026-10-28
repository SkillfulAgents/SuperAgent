// @vitest-environment jsdom
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import { Halftone, LazyHalftone } from './halftone'
import { HalftoneFrameRenderer } from './halftone-renderer'

function createCanvasContext() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    globalAlpha: 1,
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D
}

describe('Halftone animation lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('waits for visibility before starting, then pauses and resumes with intersection', () => {
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
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(intersectionCallback).toBeTypeOf('function')

    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)

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

  it('does not mount a lazy canvas until its card is near the viewport', () => {
    const intersectionCallbacks: IntersectionObserverCallback[] = []
    const disconnectObservers: ReturnType<typeof vi.fn>[] = []
    const rootMargins: string[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        disconnect = vi.fn()
        root = null
        rootMargin: string
        thresholds = [0]

        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          intersectionCallbacks.push(callback)
          disconnectObservers.push(this.disconnect)
          this.rootMargin = options?.rootMargin ?? '0px'
          rootMargins.push(this.rootMargin)
        }

        observe() {}
        unobserve() {}
        takeRecords() {
          return []
        }
      }
    )

    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1)
    const cancelAnimationFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {})

    const { container } = renderWithProviders(<LazyHalftone motif="flow_3d" />)
    expect(container.querySelector('canvas')).not.toBeInTheDocument()
    expect(intersectionCallbacks).toHaveLength(1)
    expect(rootMargins).toEqual(['320px 0px'])

    act(() => {
      intersectionCallbacks[0](
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    expect(container.querySelector('canvas')).toBeInTheDocument()
    expect(intersectionCallbacks).toHaveLength(2)
    expect(requestAnimationFrame).not.toHaveBeenCalled()

    act(() => {
      intersectionCallbacks[1](
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)

    act(() => {
      intersectionCallbacks[0](
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    expect(container.querySelector('canvas')).not.toBeInTheDocument()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
    expect(disconnectObservers[1]).toHaveBeenCalled()
  })

  it('settles on the newest entry when intersection transitions batch into one callback', () => {
    const intersectionCallbacks: IntersectionObserverCallback[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallbacks.push(callback)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
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
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    const { container } = renderWithProviders(<LazyHalftone motif="flow_3d" />)

    // A fast scroll across the lazy margin can deliver enter + exit together.
    act(() => {
      intersectionCallbacks[0](
        [
          { isIntersecting: true } as IntersectionObserverEntry,
          { isIntersecting: false } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver
      )
    })
    expect(container.querySelector('canvas')).not.toBeInTheDocument()

    act(() => {
      intersectionCallbacks[0](
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    expect(container.querySelector('canvas')).toBeInTheDocument()

    act(() => {
      intersectionCallbacks[1](
        [
          { isIntersecting: true } as IntersectionObserverEntry,
          { isIntersecting: false } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver
      )
    })
    expect(requestAnimationFrame).not.toHaveBeenCalled()
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

  it('does not reset the canvas when ResizeObserver reports the same size', () => {
    let resizeCallback: ResizeObserverCallback | undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )

    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120)
    let pixelRatio = 1
    vi.spyOn(window, 'devicePixelRatio', 'get').mockImplementation(
      () => pixelRatio
    )
    const setTransform = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform,
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)

    renderWithProviders(<Halftone motif="flow_3d" />)
    expect(setTransform).toHaveBeenCalledTimes(1)

    act(() => {
      resizeCallback?.([], {} as ResizeObserver)
    })

    expect(setTransform).toHaveBeenCalledTimes(1)

    pixelRatio = 2
    act(() => {
      resizeCallback?.([], {} as ResizeObserver)
    })

    expect(setTransform).toHaveBeenCalledTimes(2)
    expect(setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0)
  })

  it('renders a static frame for reduced motion without pointer tracking', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
    } as MediaQueryList)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(createCanvasContext())
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1)
    const addWindowListener = vi.spyOn(window, 'addEventListener')
    const draw = vi.spyOn(HalftoneFrameRenderer.prototype, 'draw')

    renderWithProviders(<Halftone motif="flow_3d" />)

    expect(draw).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(addWindowListener).not.toHaveBeenCalledWith(
      'pointermove',
      expect.any(Function),
      expect.anything()
    )
  })

  it('caps draws near 30fps despite vsync jitter and advances from wall-clock time', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(createCanvasContext())
    const callbacks: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback)
      return callbacks.length
    })
    const draw = vi.spyOn(HalftoneFrameRenderer.prototype, 'draw')

    renderWithProviders(<Halftone motif="flow_3d" />)

    act(() => callbacks.shift()?.(100))
    act(() => callbacks.shift()?.(116))
    act(() => callbacks.shift()?.(130))
    act(() => callbacks.shift()?.(160))

    expect(draw).toHaveBeenCalledTimes(3)
    expect(draw.mock.calls[0][1]).toBe(0)
    expect(draw.mock.calls[1][1]).toBeCloseTo(1.5)
    expect(draw.mock.calls[2][1]).toBeCloseTo(1.5 + 0.75 * (30 / (1000 / 60)))
    expect(draw.mock.calls[0][6]).toBeCloseTo(2)
    expect(draw.mock.calls[1][6]).toBeCloseTo(30 / (1000 / 60))
    expect(draw.mock.calls[2][6]).toBeCloseTo(30 / (1000 / 60))
  })

  it('suspends for background tabs and cleans up listeners and observers on unmount', () => {
    let hidden = false
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    const resizeDisconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect = resizeDisconnect
      }
    )
    const intersectionDisconnect = vi.fn()
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
        observe() {}
        unobserve() {}
        disconnect = intersectionDisconnect
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
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(createCanvasContext())
    let nextRaf = 1
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => nextRaf++)
    const cancelAnimationFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {})
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener')

    const { unmount } = renderWithProviders(<Halftone motif="flow_3d" />)
    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    hidden = true
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)

    hidden = false
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    unmount()

    expect(resizeDisconnect).toHaveBeenCalled()
    expect(intersectionDisconnect).toHaveBeenCalled()
    expect(removeDocumentListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    )
    expect(removeWindowListener).toHaveBeenCalledWith('pointermove', expect.any(Function))
  })
})
