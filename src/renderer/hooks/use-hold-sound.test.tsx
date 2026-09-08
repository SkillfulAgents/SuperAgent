// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const sound = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), prime: vi.fn() }))
vi.mock('@renderer/lib/speech/hold-sound', () => ({ holdSound: sound }))

const reader = vi.hoisted(() => ({ audible: false }))
vi.mock('./use-read-aloud', () => ({ readAloud: { isAudible: () => reader.audible } }))

import { useHoldSound, HOLD_DELAY_MS, HOLD_DELAY_BEFORE_TOOLS_MS } from './use-hold-sound'

describe('useHoldSound', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sound.start.mockClear()
    sound.stop.mockClear()
    sound.prime.mockClear()
    reader.audible = false
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('primes the sound when enabled, and plays once the agent has been silent for a moment', () => {
    const { rerender } = renderHook(({ agentTurn }) => useHoldSound({ enabled: true, agentTurn, working: true }), { initialProps: { agentTurn: false } })
    expect(sound.prime).toHaveBeenCalledTimes(1)
    expect(sound.start).not.toHaveBeenCalled()

    rerender({ agentTurn: true })
    vi.advanceTimersByTime(HOLD_DELAY_MS - 200)
    expect(sound.start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(sound.start).toHaveBeenCalled()
  })

  it('stops while the reply is audible and comes back in the next silence', () => {
    renderHook(() => useHoldSound({ enabled: true, agentTurn: true, working: true }))
    vi.advanceTimersByTime(HOLD_DELAY_MS + 200)
    expect(sound.start).toHaveBeenCalled()
    sound.start.mockClear()

    reader.audible = true
    vi.advanceTimersByTime(200)
    expect(sound.stop).toHaveBeenCalled()
    sound.stop.mockClear()

    // A gap between sentences, shorter than the delay: nothing.
    reader.audible = false
    vi.advanceTimersByTime(400)
    reader.audible = true
    vi.advanceTimersByTime(200)
    expect(sound.start).not.toHaveBeenCalled()

    // A tool call: silence long enough.
    reader.audible = false
    vi.advanceTimersByTime(HOLD_DELAY_MS + 200)
    expect(sound.start).toHaveBeenCalled()
  })

  it('before the first tool call it waits out an opening sentence; after, a short silence is enough', () => {
    const { rerender } = renderHook(({ working }) => useHoldSound({ enabled: true, agentTurn: true, working }), { initialProps: { working: false } })
    // "I'll look that up." arrives two seconds in: no loop was started for the wait.
    vi.advanceTimersByTime(2000)
    expect(sound.start).not.toHaveBeenCalled()
    reader.audible = true
    vi.advanceTimersByTime(600)
    // The tool call lands while the sentence is being spoken; the sentence ends.
    rerender({ working: true })
    reader.audible = false
    vi.advanceTimersByTime(HOLD_DELAY_MS - 200)
    expect(sound.start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600) // past the delay, plus one poll's granularity
    expect(sound.start).toHaveBeenCalled()
    // Becoming "working" did not restart a loop that was already playing.
    expect(sound.stop).toHaveBeenCalledTimes(3) // one per audible poll while the sentence played
  })

  it('a turn that goes quiet for a long time gets the loop even before any tool call', () => {
    renderHook(() => useHoldSound({ enabled: true, agentTurn: true, working: false }))
    vi.advanceTimersByTime(HOLD_DELAY_BEFORE_TOOLS_MS - 200)
    expect(sound.start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(sound.start).toHaveBeenCalled()
  })

  it('stops when the floor returns to the person, and when disabled', () => {
    const { rerender } = renderHook(
      ({ enabled, agentTurn }) => useHoldSound({ enabled, agentTurn, working: true }),
      { initialProps: { enabled: true, agentTurn: true } },
    )
    vi.advanceTimersByTime(HOLD_DELAY_MS + 200)
    expect(sound.start).toHaveBeenCalled()
    rerender({ enabled: true, agentTurn: false })
    expect(sound.stop).toHaveBeenCalled()

    sound.start.mockClear()
    sound.stop.mockClear()
    rerender({ enabled: true, agentTurn: true })
    vi.advanceTimersByTime(HOLD_DELAY_MS + 200)
    expect(sound.start).toHaveBeenCalled()
    rerender({ enabled: false, agentTurn: true })
    expect(sound.stop).toHaveBeenCalled()
    sound.start.mockClear()
    vi.advanceTimersByTime(HOLD_DELAY_MS * 3)
    expect(sound.start).not.toHaveBeenCalled()
  })
})
