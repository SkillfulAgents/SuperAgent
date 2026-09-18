// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceOrb } from './voice-orb'

function stubContext() {
  const ctx = { fillStyle: '', clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), setTransform: vi.fn() }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  return ctx
}

function reducedMotion(matches: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query.includes('reduce') && matches,
    media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }) as MediaQueryList)
}

describe('VoiceOrb', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('renders nothing but a canvas when the canvas has no 2D context', () => {
    const { getByTestId, unmount } = render(<VoiceOrb state="ready" size={64} getAnalyser={() => null} />)
    expect(getByTestId('voice-orb')).toHaveAttribute('data-orb-state', 'ready')
    unmount()
  })

  it('paints a frame every animation frame and stops on unmount', () => {
    const ctx = stubContext()
    reducedMotion(false)
    const callbacks: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { callbacks.push(cb); return callbacks.length })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    const { unmount } = render(<VoiceOrb state="user" size={64} getAnalyser={() => null} />)
    expect(callbacks).toHaveLength(1)
    callbacks[0](1000)
    expect(ctx.arc).toHaveBeenCalled()
    expect(callbacks).toHaveLength(2)
    const painted = ctx.arc.mock.calls.length
    callbacks[1](1016)
    expect(ctx.arc.mock.calls.length).toBeGreaterThan(painted)

    unmount()
    expect(cancel).toHaveBeenCalled()
    const before = callbacks.length
    callbacks[before - 1](1032)
    expect(callbacks).toHaveLength(before)
  })

  it('draws one still frame per state under reduced motion, with no loop', () => {
    const ctx = stubContext()
    reducedMotion(true)
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)

    const { rerender, unmount } = render(<VoiceOrb state="ready" size={64} getAnalyser={() => null} />)
    expect(raf).not.toHaveBeenCalled()
    const first = ctx.arc.mock.calls.length
    expect(first).toBeGreaterThan(0)
    rerender(<VoiceOrb state="agent" size={64} getAnalyser={() => null} />)
    expect(ctx.arc.mock.calls.length).toBeGreaterThan(first)
    expect(raf).not.toHaveBeenCalled()
    unmount()
  })
})
