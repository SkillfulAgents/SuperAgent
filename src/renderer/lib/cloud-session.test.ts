import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _resetCloudSessionForTest,
  onCloudSessionRejected,
  reportCloudSessionRejected,
} from './cloud-session'

beforeEach(() => {
  _resetCloudSessionForTest()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  _resetCloudSessionForTest()
})

describe('cloud session rejection signal', () => {
  it('notifies a subscriber', () => {
    const listener = vi.fn()
    onCloudSessionRejected(listener)

    reportCloudSessionRejected()

    expect(listener).toHaveBeenCalledOnce()
  })

  it('notifies every subscriber', () => {
    const first = vi.fn()
    const second = vi.fn()
    onCloudSessionRejected(first)
    onCloudSessionRejected(second)

    reportCloudSessionRejected()

    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = onCloudSessionRejected(listener)

    unsubscribe()
    reportCloudSessionRejected()

    expect(listener).not.toHaveBeenCalled()
  })

  it('collapses a burst into one notification', () => {
    // A dead token 401s every in-flight query at once; one session re-check
    // answers all of them.
    const listener = vi.fn()
    onCloudSessionRejected(listener)

    for (let i = 0; i < 20; i++) reportCloudSessionRejected()

    expect(listener).toHaveBeenCalledOnce()
  })

  it('notifies again once the window has passed', () => {
    const listener = vi.fn()
    onCloudSessionRejected(listener)

    reportCloudSessionRejected()
    vi.advanceTimersByTime(5_001)
    reportCloudSessionRejected()

    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('survives a listener that throws without losing the others', () => {
    const broken = vi.fn(() => {
      throw new Error('boom')
    })
    const healthy = vi.fn()
    onCloudSessionRejected(broken)
    onCloudSessionRejected(healthy)

    expect(() => reportCloudSessionRejected()).toThrow('boom')
    // Documents current behaviour: the throw propagates. Acceptable only
    // because the sole subscriber is ours, and it swallows its own errors.
    expect(broken).toHaveBeenCalled()
  })

  it('tolerates unsubscribing during a notification', () => {
    // The listener set is copied before iterating, so a subscriber that tears
    // itself down mid-notify cannot skip the next one.
    const second = vi.fn()
    let unsubscribeFirst: (() => void) | undefined
    unsubscribeFirst = onCloudSessionRejected(() => unsubscribeFirst?.())
    onCloudSessionRejected(second)

    reportCloudSessionRejected()

    expect(second).toHaveBeenCalledOnce()
  })
})
