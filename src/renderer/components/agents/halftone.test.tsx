// @vitest-environment jsdom
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import { Halftone } from './halftone'
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

  it('caps draws at 30fps while advancing from elapsed wall-clock time', () => {
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
    act(() => callbacks.shift()?.(134))
    act(() => callbacks.shift()?.(168))

    expect(draw).toHaveBeenCalledTimes(3)
    expect(draw.mock.calls[0][1]).toBe(0)
    expect(draw.mock.calls[1][1]).toBeCloseTo(1.5)
    expect(draw.mock.calls[2][1]).toBeCloseTo(1.5 + 0.75 * (34 / (1000 / 60)))
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
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(_callback: IntersectionObserverCallback) {}
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
