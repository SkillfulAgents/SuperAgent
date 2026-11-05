import { describe, expect, it, vi } from 'vitest'
import { fillSessionComposer, focusSessionComposer, registerSessionComposerFill, registerSessionComposerFocus } from './composer-focus'

describe('composer focus registry', () => {
  it('focuses the handler registered for the session', () => {
    const focus = vi.fn()
    const unregister = registerSessionComposerFocus('s-1', focus)

    focusSessionComposer('s-1')
    expect(focus).toHaveBeenCalledTimes(1)

    unregister()
    focusSessionComposer('s-1')
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for sessions with no registered composer', () => {
    expect(() => focusSessionComposer('missing')).not.toThrow()
  })

  it('keeps a newer registration when a stale cleanup runs after a remount', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unregisterFirst = registerSessionComposerFocus('s-2', first)
    registerSessionComposerFocus('s-2', second)

    unregisterFirst()
    focusSessionComposer('s-2')

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('puts text in the session composer, and says when none is mounted', () => {
    const fill = vi.fn()
    const unregister = registerSessionComposerFill('s-3', fill)

    expect(fillSessionComposer('s-3', 'the thread')).toBe(true)
    expect(fill).toHaveBeenCalledWith('the thread')

    unregister()
    expect(fillSessionComposer('s-3', 'again')).toBe(false)
    expect(fill).toHaveBeenCalledTimes(1)
  })
})
