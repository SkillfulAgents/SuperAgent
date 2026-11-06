// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BAND_COUNT } from '@renderer/lib/voice/orb/voice-spectrum'
import { VoiceBars } from './voice-bars'

const props = {
  agentColor: '#1763af',
  getAgentAnalyser: () => null,
  getPersonAnalyser: () => null,
  agentSpeaking: false,
  personMuted: true,
}

function canvasContext() {
  const ctx = { fillStyle: '', globalAlpha: 1, clearRect: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), setTransform: vi.fn() }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  return ctx
}

function reduceMotion() {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))
const heights = (ctx: ReturnType<typeof canvasContext>) => ctx.roundRect.mock.calls.slice(-BAND_COUNT).map(call => call[3] as number)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('VoiceBars', () => {
  it('holds unmetered speech still under reduced motion and updates when speech ends', () => {
    const ctx = canvasContext()
    reduceMotion()
    const { rerender } = render(<VoiceBars {...props} agentSpeaking />)
    advance(32)
    expect(Math.max(...heights(ctx))).toBeGreaterThan(3)
    expect(ctx.clearRect).toHaveBeenCalledTimes(1)
    advance(2000)
    expect(ctx.clearRect).toHaveBeenCalledTimes(1)

    rerender(<VoiceBars {...props} />)
    advance(32)
    expect(heights(ctx).every(height => height === 3)).toBe(true)
    expect(ctx.clearRect).toHaveBeenCalledTimes(2)
    advance(2000)
    expect(ctx.clearRect).toHaveBeenCalledTimes(2)
  })

  it('keeps synthetic speech animated without reduced motion and stops repainting after it settles', () => {
    const ctx = canvasContext()
    const { rerender } = render(<VoiceBars {...props} agentSpeaking />)
    advance(500)
    const first = heights(ctx)
    advance(500)
    expect(heights(ctx)).not.toEqual(first)

    rerender(<VoiceBars {...props} />)
    advance(2000)
    expect(Math.max(...heights(ctx))).toBeLessThan(3.1)
    const paints = ctx.clearRect.mock.calls.length
    advance(2000)
    expect(ctx.clearRect).toHaveBeenCalledTimes(paints)
  })

  it('picks up an analyser without a rerender and still shows measured levels under reduced motion', () => {
    const ctx = canvasContext()
    reduceMotion()
    let analyser: AnalyserNode | null = null
    let loud = true
    render(<VoiceBars {...props} personMuted={false} getPersonAnalyser={() => analyser} />)
    advance(500)
    expect(ctx.clearRect).toHaveBeenCalledTimes(1)

    analyser = {
      fftSize: 256,
      frequencyBinCount: 128,
      context: { sampleRate: 16000 },
      getByteTimeDomainData: (out: Uint8Array) => out.fill(loud ? 160 : 128),
      getFloatFrequencyData: (out: Float32Array) => out.fill(-20),
    } as unknown as AnalyserNode
    advance(500)
    expect(Math.max(...heights(ctx))).toBeGreaterThan(20)
    loud = false
    advance(2000)
    expect(Math.max(...heights(ctx))).toBeLessThan(3.1)
  })

  it('repaints a settled row when its colour or size changes', () => {
    const ctx = canvasContext()
    const { rerender } = render(<VoiceBars {...props} />)
    advance(500)
    expect(ctx.clearRect).toHaveBeenCalledTimes(1)
    rerender(<VoiceBars {...props} agentColor="#ff0000" />)
    advance(32)
    expect(ctx.clearRect).toHaveBeenCalledTimes(2)
    expect(ctx.fillStyle).toBe('#ff0000')
    rerender(<VoiceBars {...props} agentColor="#ff0000" scale={2} />)
    advance(32)
    expect(ctx.clearRect).toHaveBeenCalledTimes(3)
  })

  it('samples only when both the canvas and document are visible, and cleans up on unmount', () => {
    const ctx = canvasContext()
    const getPersonAnalyser = vi.fn(() => null)
    let notify: IntersectionObserverCallback
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notify = callback }
      observe() {}
      unobserve() {}
      disconnect = disconnect
    })
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const { getByTestId, unmount } = render(<VoiceBars {...props} personMuted={false} getPersonAnalyser={getPersonAnalyser} />)
    const intersect = (visible: boolean, ratio = visible ? 1 : 0) => act(() => {
      const target = getByTestId('voice-bars')
      const rect = target.getBoundingClientRect()
      notify([{
        target, isIntersecting: visible, intersectionRatio: ratio,
        boundingClientRect: rect, intersectionRect: rect, rootBounds: null, time: performance.now(),
      }], {} as IntersectionObserver)
    })
    const showDocument = (visible: boolean) => act(() => {
      hidden.mockReturnValue(!visible)
      document.dispatchEvent(new Event('visibilitychange'))
    })

    intersect(true)
    advance(100)
    expect(getPersonAnalyser).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    showDocument(true)
    advance(100)
    expect(ctx.clearRect).toHaveBeenCalledTimes(1)
    expect(getPersonAnalyser).toHaveBeenCalled()

    intersect(false)
    getPersonAnalyser.mockClear()
    advance(100)
    expect(getPersonAnalyser).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    showDocument(false)
    showDocument(true)
    advance(100)
    expect(getPersonAnalyser).not.toHaveBeenCalled()
    intersect(true, 0)
    advance(100)
    expect(getPersonAnalyser).not.toHaveBeenCalled()
    intersect(true)
    advance(100)
    expect(getPersonAnalyser).toHaveBeenCalled()

    showDocument(false)
    getPersonAnalyser.mockClear()
    advance(100)
    expect(getPersonAnalyser).not.toHaveBeenCalled()
    showDocument(true)
    advance(100)
    expect(getPersonAnalyser).toHaveBeenCalled()
    unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
