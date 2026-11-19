// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWindowActive, subscribeToWindowActive } from './window-active'

describe('window active', () => {
  let hasFocus: ReturnType<typeof vi.spyOn>
  let hidden: boolean
  let stop: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    hidden = false
    hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  })

  afterEach(() => {
    stop?.()
    stop = undefined
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('hears of focus leaving from inside an embedded frame, which fires nothing on the window', () => {
    const listener = vi.fn()
    stop = subscribeToWindowActive(listener)
    hasFocus.mockReturnValue(false)
    vi.advanceTimersByTime(1000)
    expect(listener).toHaveBeenCalledWith(false)
    expect(isWindowActive()).toBe(false)
  })

  it('stops asking while the document is hidden, and asks again when it is shown', () => {
    stop = subscribeToWindowActive(vi.fn())
    expect(vi.getTimerCount()).toBe(1)

    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)

    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(1)

    stop()
    stop = undefined
    expect(vi.getTimerCount()).toBe(0)
  })
})
