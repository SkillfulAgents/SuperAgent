// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DisplacedDotField } from './displaced-dot-field'

let now: number
let nextFrame: number
let frames: Map<number, FrameRequestCallback>
let dots: [number, number][]
let intersect: IntersectionObserverCallback

const context = {
  fillStyle: '',
  setTransform: vi.fn(),
  clearRect: vi.fn(() => { dots = [] }),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  arc: vi.fn((x: number, y: number) => { dots.push([x, y]) }),
  fill: vi.fn(),
}

function frameAt(time: number) {
  now = time
  const pending = [...frames.values()]
  frames.clear()
  act(() => pending.forEach((callback) => callback(now)))
}

function visibility(visible: boolean) {
  act(() => intersect([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver))
}

function ripple() {
  fireEvent.click(document.body, { button: 0, clientX: 60, clientY: 60 })
}

beforeEach(() => {
  now = 0
  nextFrame = 0
  frames = new Map()
  dots = []
  vi.clearAllMocks()
  document.documentElement.classList.remove('dark')
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback }
    observe() {}
    disconnect() {}
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 120, width: 120, height: 120, toJSON() {},
  })
  vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: true } as Selection)
  const computedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => element instanceof HTMLCanvasElement
    ? { color: document.documentElement.classList.contains('dark') ? 'rgb(250, 250, 250)' : 'rgb(10, 10, 10)' } as CSSStyleDeclaration
    : computedStyle(element))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('dark')
})

describe('DisplacedDotField', () => {
  it('moves the same distance over one second at 30, 60 and 120 Hz, drawing at most 60 times', () => {
    const simulate = (hz: number) => {
      now = 0
      const { unmount } = render(<DisplacedDotField />)
      const rest = [...dots]
      const before = context.clearRect.mock.calls.length
      ripple()
      for (let i = 1; i <= hz; i++) frameAt(i * 1000 / hz)
      const result = { dots: [...dots], draws: context.clearRect.mock.calls.length - before }
      expect(result.dots).not.toEqual(rest)
      unmount()
      expect(frames.size).toBe(0)
      return result
    }

    const slow = simulate(30)
    const normal = simulate(60)
    const fast = simulate(120)
    expect(slow.dots).toEqual(normal.dots)
    expect(fast.dots).toEqual(normal.dots)
    expect([slow.draws, normal.draws, fast.draws]).toEqual([30, 60, 60])
  })

  it('bounds catch-up after a long frame instead of simulating the whole pause', () => {
    render(<DisplacedDotField />)
    const rest = [...dots]
    ripple()
    frameAt(10_000)
    expect(dots).not.toEqual(rest)
    expect(dots.flat().every(Number.isFinite)).toBe(true)
    expect(frames.size).toBe(1)
  })

  it('repaints a parked field on a theme change without starting an animation', async () => {
    render(<DisplacedDotField />)
    const before = context.clearRect.mock.calls.length
    expect(context.fillStyle).toBe('rgba(10, 10, 10, 0.2)')
    await act(async () => { document.documentElement.classList.add('dark') })
    expect(context.fillStyle).toBe('rgba(250, 250, 250, 0.2)')
    expect(context.clearRect).toHaveBeenCalledTimes(before + 1)
    expect(frames.size).toBe(0)
  })

  it('resumes healing on reentry without catching up the time spent offscreen', () => {
    render(<DisplacedDotField />)
    const rest = [...dots]
    ripple()
    frameAt(50)
    visibility(false)
    const paused = [...dots]
    expect(frames.size).toBe(0)
    frameAt(10_000)
    visibility(true)
    frameAt(10_000 + 1000 / 60)
    expect(dots).not.toEqual(paused)
    expect(dots).not.toEqual(rest)
    for (let i = 2; i <= 600; i++) frameAt(10_000 + i * 1000 / 60)
    expect(dots).toEqual(rest)
    expect(frames.size).toBe(0)
  })

  it('keeps reduced motion static while still following theme changes', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    render(<DisplacedDotField intro />)
    const rest = [...dots]
    ripple()
    frameAt(1000)
    expect(dots).toEqual(rest)
    expect(frames.size).toBe(0)
    await act(async () => { document.documentElement.classList.add('dark') })
    expect(context.fillStyle).toBe('rgba(250, 250, 250, 0.2)')
    expect(dots).toEqual(rest)
    expect(frames.size).toBe(0)
  })
})
