// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAutoHideScrollbar } from './use-auto-hide-scrollbar'

describe('useAutoHideScrollbar', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('marks the scroller while it scrolls and clears the mark a moment after the last scroll', () => {
    const { result } = renderHook(() => useAutoHideScrollbar())
    const scroller = document.createElement('div')

    result.current(scroller)
    expect(scroller.hasAttribute('data-scrolling')).toBe(true)

    // Each scroll restarts the wait.
    vi.advanceTimersByTime(600)
    result.current(scroller)
    vi.advanceTimersByTime(600)
    expect(scroller.hasAttribute('data-scrolling')).toBe(true)

    vi.advanceTimersByTime(400)
    expect(scroller.hasAttribute('data-scrolling')).toBe(false)
  })

  it('does not clear the mark after unmounting', () => {
    const { result, unmount } = renderHook(() => useAutoHideScrollbar())
    const scroller = document.createElement('div')
    result.current(scroller)
    unmount()
    expect(() => vi.runAllTimers()).not.toThrow()
  })
})
