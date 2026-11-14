// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installAmbientAnimationPause } from './ambient-styles'

interface FakeAnimation {
  playState: 'running' | 'paused' | 'finished'
  playbackRate: number
  effect: { target?: Element; getComputedTiming: () => { iterations: number; activeDuration: number } }
  pause: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
}

function animation(iterations: number, activeDuration: number, target?: Element): FakeAnimation {
  return {
    playState: 'running',
    playbackRate: 1,
    effect: { target, getComputedTiming: () => ({ iterations, activeDuration }) },
    pause: vi.fn(),
    play: vi.fn(),
  }
}

/** A CSS animation starting on `element`, as the browser announces it. */
function start(element: Element, animations: FakeAnimation[]) {
  ;(element as unknown as { getAnimations: () => FakeAnimation[] }).getAnimations = () => animations
  element.dispatchEvent(new Event('animationstart', { bubbles: true }))
}

describe('ambient animation pause', () => {
  let hasFocus: ReturnType<typeof vi.spyOn>
  let running: FakeAnimation[]
  let uninstall: (() => void) | undefined
  const background = () => {
    hasFocus.mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
  }
  const foreground = () => {
    hasFocus.mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
  }

  beforeEach(() => {
    running = []
    hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    // jsdom has no Web Animations.
    ;(document as unknown as { getAnimations: () => FakeAnimation[] }).getAnimations = () => running
  })

  afterEach(() => {
    uninstall?.()
    uninstall = undefined
    delete (document as unknown as { getAnimations?: unknown }).getAnimations
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('holds looping and very long animations in the background, and leaves an entrance to finish', () => {
    const spinner = animation(Infinity, Infinity)
    const rainbow = animation(10, 50_000)
    const reversed = animation(Infinity, Infinity)
    reversed.playbackRate = -2
    const entrance = animation(1, 300)
    running = [spinner, rainbow, reversed, entrance]
    uninstall = installAmbientAnimationPause()
    expect(spinner.playbackRate).toBe(1)

    background()
    expect(spinner.playbackRate).toBe(0)
    expect(rainbow.playbackRate).toBe(0)
    expect(reversed.playbackRate).toBe(0)
    expect(entrance.playbackRate).toBe(1)

    foreground()
    expect(spinner.playbackRate).toBe(1)
    expect(rainbow.playbackRate).toBe(1)
    expect(reversed.playbackRate).toBe(-2)
  })

  it('never pauses or plays an animation, which would take it from its animation-play-state for good', () => {
    // A ticker that pauses under the pointer: after pause() and play() its CSS rule no longer reaches it.
    const ticker = animation(Infinity, Infinity)
    const pausedByPage = animation(Infinity, Infinity)
    pausedByPage.playState = 'paused'
    running = [ticker, pausedByPage]
    uninstall = installAmbientAnimationPause()

    background()
    // The pointer comes to rest on the ticker while it is held, and is still there afterwards.
    ticker.playState = 'paused'
    foreground()
    for (const each of [ticker, pausedByPage]) {
      expect(each.pause).not.toHaveBeenCalled()
      expect(each.play).not.toHaveBeenCalled()
    }
    expect(ticker.playbackRate).toBe(1)
    expect(pausedByPage.playbackRate).toBe(1)
  })

  it('holds a loop that starts while the window is in the background, looking only at its element', () => {
    uninstall = installAmbientAnimationPause()
    background()
    const everything = vi.fn(() => [])
    ;(document as unknown as { getAnimations: () => FakeAnimation[] }).getAnimations = everything
    const element = document.body.appendChild(document.createElement('div'))
    const late = animation(Infinity, Infinity, element)
    const word = animation(1, 200, element)
    start(element, [late, word])
    expect(late.playbackRate).toBe(0)
    expect(word.playbackRate).toBe(1)
    // A reply streaming in the background starts an animation a word: none scans the page.
    expect(everything).not.toHaveBeenCalled()

    foreground()
    expect(late.playbackRate).toBe(1)
  })

  it('does no work while held: no timer runs in a window left in the background', () => {
    vi.useFakeTimers()
    uninstall = installAmbientAnimationPause()
    const before = vi.getTimerCount()
    background()
    // Only window-active's own focus poll, which the install started.
    expect(vi.getTimerCount()).toBe(before)
  })

  it('holds a muted looping video and an SVG loop, and resumes them', () => {
    document.body.innerHTML = '<video loop></video><video></video><svg><rect><animate /></rect></svg><svg><rect /></svg>'
    const [decoration, watched] = Array.from(document.querySelectorAll('video'))
    for (const video of [decoration, watched]) {
      Object.defineProperty(video, 'paused', { value: false, configurable: true })
      video.muted = true
      video.pause = vi.fn()
      video.play = vi.fn(() => Promise.resolve())
    }
    const [looping, still] = Array.from(document.querySelectorAll('svg'))
    for (const svg of [looping, still]) {
      svg.animationsPaused = vi.fn(() => false)
      svg.pauseAnimations = vi.fn()
      svg.unpauseAnimations = vi.fn()
    }
    uninstall = installAmbientAnimationPause()

    background()
    expect(decoration.pause).toHaveBeenCalledTimes(1)
    expect(watched.pause).not.toHaveBeenCalled()
    expect(looping.pauseAnimations).toHaveBeenCalledTimes(1)
    expect(still.pauseAnimations).not.toHaveBeenCalled()

    foreground()
    expect(decoration.play).toHaveBeenCalledTimes(1)
    expect(looping.unpauseAnimations).toHaveBeenCalledTimes(1)
  })
})
