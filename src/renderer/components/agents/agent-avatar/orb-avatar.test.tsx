// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_ORBS } from './avatar-orbs'
import { OrbAvatar, type AvatarMotionState } from './orb-avatar'
import { orbShape, shapePath, type OrbShapeName } from './orb-shapes'

const layer = (name: string) => document.querySelector(`[data-orb-layer="${name}"]`) as HTMLElement
const body = () => layer('glow').parentElement as HTMLElement
// The face's translate(x, y): where it sits relative to the centre.
const faceOffset = () => layer('face').style.transform.match(/translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\)/)!.slice(1).map(Number)
const dotsShown = () => [...document.querySelectorAll<HTMLElement>('[data-orb-layer="dot"]')].filter(dot => dot.style.display !== 'none').length

// Step the shared frame loop in frame-sized slices, letting React render between them.
const advance = (ms: number) => {
  for (let t = 0; t < ms; t += 50) act(() => vi.advanceTimersByTime(50))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const orb = (state: AvatarMotionState, shape: OrbShapeName = 'circle', followPointer?: string) => (
  <div data-testid="region" data-follow="">
    <OrbAvatar orb={DEFAULT_ORBS[0]} shape={orbShape(shape)} diameter={28} restingPhi={-90} state={state} followPointer={followPointer} />
  </div>
)

describe('OrbAvatar follow within a region', () => {
  const place = () => {
    // jsdom has no layout: place the orb at (100, 100), 28px across.
    const root = document.querySelector('[data-avatar-orb]') as HTMLElement
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      left: 86, top: 86, width: 28, height: 28, right: 114, bottom: 114, x: 86, y: 86, toJSON: () => ({}),
    })
  }
  const move = (target: EventTarget, clientX: number, clientY: number) =>
    target.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY, bubbles: true }))

  // A done orb holds still after its nod (face tipped up), which makes a clean baseline.
  it('looks at a cursor inside the region and returns to its own pose when it leaves', () => {
    render(orb('done', 'circle', '[data-follow]'))
    place()
    advance(2500)
    expect(Math.abs(faceOffset()[0])).toBeLessThan(0.5)
    expect(faceOffset()[1]).toBeLessThan(0)

    act(() => move(screen.getByTestId('region'), 300, 100)) // far to the right
    advance(500)
    expect(faceOffset()[0]).toBeGreaterThan(5)
    expect(Math.abs(faceOffset()[1])).toBeLessThan(1)

    act(() => screen.getByTestId('region').dispatchEvent(new MouseEvent('pointerleave')))
    advance(600)
    expect(Math.abs(faceOffset()[0])).toBeLessThan(0.5)
    expect(faceOffset()[1]).toBeLessThan(0)
  })

  it('ignores the cursor outside the region', () => {
    render(orb('done', 'circle', '[data-follow]'))
    place()
    advance(2500)
    act(() => move(document.body, 300, 100))
    advance(500)
    expect(Math.abs(faceOffset()[0])).toBeLessThan(0.5)
    expect(faceOffset()[1]).toBeLessThan(0)
  })

  it('does not follow while asleep', () => {
    render(orb('sleeping', 'circle', '[data-follow]'))
    place()
    advance(500)
    act(() => move(screen.getByTestId('region'), 400, 100)) // far to the right
    advance(500)
    // Still centred, not turned toward the cursor.
    expect(Math.abs(faceOffset()[0])).toBeLessThan(0.01)
    expect(Math.abs(faceOffset()[1])).toBeLessThan(0.01)
  })

  it('measures only after pointer or layout changes', () => {
    render(orb('done', 'circle', '[data-follow]'))
    place()
    const root = document.querySelector('[data-avatar-orb]') as HTMLElement
    const measure = vi.mocked(root.getBoundingClientRect)
    act(() => move(screen.getByTestId('region'), 300, 100))
    advance(1000)
    expect(measure).toHaveBeenCalledTimes(1)
    advance(1000)
    expect(measure).toHaveBeenCalledTimes(1)
    act(() => window.dispatchEvent(new Event('scroll')))
    advance(50)
    expect(measure).toHaveBeenCalledTimes(2)
  })
})

describe('OrbAvatar states', () => {
  it('invalidates typing-dot geometry when the shape changes', () => {
    const { rerender } = render(orb('working', 'circle'))
    advance(2000)
    const dot = layer('dot')
    const size = Math.round(Number.parseFloat(dot.style.width) * 2) / 2
    expect(dot.style.clipPath).toBe(`path('${shapePath(orbShape('circle'), size)}')`)
    rerender(orb('working', 'triangle'))
    advance(50)
    expect(dot.style.clipPath).toBe(`path('${shapePath(orbShape('triangle'), size)}')`)
    // Steady typing moves through transforms, without changing layout geometry.
    const width = dot.style.width
    const position = dot.style.transform
    advance(250)
    expect(dot.style.width).toBe(width)
    expect(dot.style.left).toBe('0px')
    expect(dot.style.top).toBe('0px')
    expect(dot.style.transform).not.toBe(position)
  })

  it('keeps the current still state after changing shape under reduced motion', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const { rerender } = render(orb('idle', 'circle'))
    rerender(orb('sleeping', 'circle'))
    rerender(orb('sleeping', 'triangle'))
    expect(layer('face').style.opacity).toBe('0')
    expect(raf).not.toHaveBeenCalled()
  })

  it('turns into typing dots while working and keeps them, then plays out the gather when work stops', () => {
    const { rerender } = render(orb('working', 'squircle'))
    advance(2000)
    expect(dotsShown()).toBe(3)
    // Well past where a looping cycle would bring the avatar back: still dots.
    advance(8000)
    expect(dotsShown()).toBe(3)

    rerender(orb('idle', 'squircle'))
    // Still finishing: the dots gather back before the orb returns.
    advance(100)
    expect(dotsShown()).toBe(3)
    advance(2500)
    expect(dotsShown()).toBe(0)
  })

  it('settles straight back if work stops before the dots form', () => {
    const { rerender } = render(orb('working'))
    advance(200)
    expect(dotsShown()).toBe(0)
    rerender(orb('idle'))
    advance(2000)
    expect(dotsShown()).toBe(0)
  })

  it('sleeps upright: hides its face, mutes its colour and breathes', () => {
    render(orb('sleeping'))
    advance(1000)
    // No face: a shut eye read as a mouth.
    expect(layer('face').style.opacity).toBe('0')
    // Upright: the body has no rotation at all.
    expect(body().style.filter).toBe('saturate(0.85)')
    const glowA = Number(layer('glow').style.opacity)
    advance(2000)
    expect(Number(layer('glow').style.opacity)).not.toBeCloseTo(glowA, 2)
  })

  it('knocks and hops while needing input', () => {
    render(orb('needs-input'))
    const jumps: number[] = []
    for (let i = 0; i < 36; i++) {
      advance(100)
      jumps.push(Number(body().style.transform.match(/translateY\((-?[\d.e-]+)px\)/)![1]))
    }
    // Rises off its base (negative = up) during the hop, and lands again.
    expect(Math.min(...jumps)).toBeLessThan(-4)
    expect(Math.max(...jumps)).toBeCloseTo(0, 0)
  })

  it('nods once when done, then rests facing you with its face tipped up', () => {
    render(orb('done'))
    advance(2500)
    // Gaze down, distance negative: the face sits above the centre.
    expect(faceOffset()[1]).toBeLessThan(0)
    expect(Math.abs(faceOffset()[0])).toBeLessThan(0.5)
  })

  it('blends between states rather than jumping', () => {
    const { rerender } = render(orb('idle'))
    advance(200)
    rerender(orb('sleeping'))
    advance(200)
    // Halfway into sleep: the face is fading, not yet gone.
    const faceOpacity = Number(layer('face').style.opacity)
    expect(faceOpacity).toBeGreaterThan(0.05)
    expect(faceOpacity).toBeLessThan(0.95)
  })
})

describe('OrbAvatar visibility', () => {
  function intersections() {
    let notify: IntersectionObserverCallback
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notify = callback }
      observe() {}
      unobserve() {}
      disconnect = disconnect
    })
    return {
      disconnect,
      set: (visible: boolean, ratio = visible ? 1 : 0) => act(() => notify(
        [...document.querySelectorAll('[data-avatar-orb]')].map(target => ({ target, isIntersecting: visible, intersectionRatio: ratio }) as IntersectionObserverEntry),
        {} as IntersectionObserver,
      )),
    }
  }

  it('waits for visible area, stops offscreen, and resumes an ongoing working animation', () => {
    const visibility = intersections()
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const { unmount } = render(orb('working'))
    expect(raf).not.toHaveBeenCalled()
    visibility.set(true, 0) // touching the viewport edge is not visible
    expect(raf).not.toHaveBeenCalled()
    visibility.set(true)
    advance(2000)
    expect(dotsShown()).toBe(3)
    visibility.set(false)
    raf.mockClear()
    const position = layer('dot').style.transform
    advance(5000)
    expect(raf).not.toHaveBeenCalled()
    expect(layer('dot').style.transform).toBe(position)
    visibility.set(true)
    advance(100)
    expect(dotsShown()).toBe(3) // no replay of the intro
    unmount()
    expect(visibility.disconnect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the latest state when returning onscreen', () => {
    const visibility = intersections()
    const { rerender } = render(orb('working'))
    visibility.set(true)
    advance(2000)
    visibility.set(false)
    rerender(orb('sleeping'))
    advance(5000)
    visibility.set(true)
    advance(2500)
    expect(dotsShown()).toBe(0)
    expect(layer('face').style.opacity).toBe('0')
  })

  it('stops all frame work when the document is hidden', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    render(orb('sleeping'))
    advance(1000)
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    act(() => {
      hidden.mockReturnValue(true)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const glow = layer('glow').style.opacity
    advance(2000)
    expect(raf).not.toHaveBeenCalled()
    expect(layer('glow').style.opacity).toBe(glow)
    act(() => {
      hidden.mockReturnValue(false)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    advance(1000)
    expect(raf).toHaveBeenCalled()
  })
})
