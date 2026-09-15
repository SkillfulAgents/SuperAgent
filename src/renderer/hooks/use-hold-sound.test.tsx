// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
const reader = vi.hoisted(() => ({ isAudible: vi.fn(() => false) }))
vi.mock('./use-read-aloud', () => ({ readAloud: reader }))
const sound = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), stopImmediately: vi.fn(), prime: vi.fn() }))
vi.mock('@renderer/lib/speech/hold-sound', () => ({ holdSound: sound }))
import { useHoldSound, HOLD_DELAY_MS, HOLD_DELAY_BEFORE_TOOLS_MS } from './use-hold-sound'

describe('useHoldSound', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); reader.isAudible.mockReturnValue(false) })
  afterEach(() => vi.useRealTimers())

  it('primes when enabled and waits for an eligible silent period', () => {
    const { rerender } = renderHook(({ agentTurn }) => useHoldSound({ enabled: true, agentTurn, working: true }), { initialProps: { agentTurn: false } })
    expect(sound.prime).toHaveBeenCalledOnce()
    expect(sound.start).not.toHaveBeenCalled()
    rerender({ agentTurn: true })
    vi.advanceTimersByTime(HOLD_DELAY_MS - 200)
    expect(sound.start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(sound.start).toHaveBeenCalled()
  })

  it('cuts on either participant speaking and waits out short gaps before restarting', () => {
    const { rerender } = renderHook(({ speaking }) => useHoldSound({ enabled: true, agentTurn: true, working: true, speaking }), { initialProps: { speaking: false } })
    vi.advanceTimersByTime(HOLD_DELAY_MS + 200)
    expect(sound.start).toHaveBeenCalled()
    sound.start.mockClear()
    rerender({ speaking: true })
    expect(sound.stopImmediately).toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(sound.start).not.toHaveBeenCalled()
    rerender({ speaking: false })
    vi.advanceTimersByTime(400)
    rerender({ speaking: true })
    expect(sound.start).not.toHaveBeenCalled()
    rerender({ speaking: false })
    vi.advanceTimersByTime(HOLD_DELAY_MS + 200)
    expect(sound.start).toHaveBeenCalled()
  })

  it('uses a longer wait before the first tool call and shortens it when tools start', () => {
    const { rerender } = renderHook(({ working }) => useHoldSound({ enabled: true, agentTurn: true, working }), { initialProps: { working: false } })
    vi.advanceTimersByTime(2000)
    expect(sound.start).not.toHaveBeenCalled()
    rerender({ working: true })
    vi.advanceTimersByTime(200)
    expect(sound.start).toHaveBeenCalled()
  })

  it('can fill a long silence before any tool call', () => {
    renderHook(() => useHoldSound({ enabled: true, agentTurn: true, working: false }))
    vi.advanceTimersByTime(HOLD_DELAY_BEFORE_TOOLS_MS - 200)
    expect(sound.start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(sound.start).toHaveBeenCalled()
  })

  it('stops when no longer eligible or disabled', () => {
    const { rerender } = renderHook(({ enabled, agentTurn }) => useHoldSound({ enabled, agentTurn, working: true }), { initialProps: { enabled: true, agentTurn: true } })
    vi.advanceTimersByTime(HOLD_DELAY_MS + 200)
    rerender({ enabled: true, agentTurn: false })
    expect(sound.stop).toHaveBeenCalled()
    sound.start.mockClear()
    vi.advanceTimersByTime(10_000)
    expect(sound.start).not.toHaveBeenCalled()
    rerender({ enabled: true, agentTurn: true })
    vi.advanceTimersByTime(HOLD_DELAY_MS + 200)
    expect(sound.start).toHaveBeenCalled()
    sound.start.mockClear()
    rerender({ enabled: false, agentTurn: true })
    vi.advanceTimersByTime(10_000)
    expect(sound.start).not.toHaveBeenCalled()
  })

  it('yields to standalone read-aloud even when the conversation engine is silent', () => {
    renderHook(() => useHoldSound({ enabled: true, agentTurn: true, working: true, speaking: false }))
    vi.advanceTimersByTime(1000)
    expect(sound.start).toHaveBeenCalled()
    sound.start.mockClear()
    reader.isAudible.mockReturnValue(true)
    vi.advanceTimersByTime(200)
    expect(sound.stopImmediately).toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(sound.start).not.toHaveBeenCalled()
    reader.isAudible.mockReturnValue(false)
    vi.advanceTimersByTime(400)
    expect(sound.start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600)
    expect(sound.start).toHaveBeenCalled()
  })

  it('drives whichever source it is handed, and hands the old one back when it changes', () => {
    const music = { start: vi.fn(), stop: vi.fn(), stopImmediately: vi.fn(), prime: vi.fn() }
    const { rerender } = renderHook(({ source }) => useHoldSound({ enabled: true, agentTurn: true, working: true, source }), { initialProps: { source: music } })
    expect(music.prime).toHaveBeenCalledOnce()
    expect(sound.prime).not.toHaveBeenCalled()
    vi.advanceTimersByTime(HOLD_DELAY_MS + 200)
    expect(music.start).toHaveBeenCalled()
    expect(sound.start).not.toHaveBeenCalled()
    rerender({ source: sound })
    expect(music.stop).toHaveBeenCalled()
    vi.advanceTimersByTime(HOLD_DELAY_MS + 200)
    expect(sound.start).toHaveBeenCalled()
  })

  it('takes an explicit delay policy without knowing the provider', () => {
    renderHook(() => useHoldSound({ enabled: true, agentTurn: true, working: true, delayMs: 2000 }))
    vi.advanceTimersByTime(1800)
    expect(sound.start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(sound.start).toHaveBeenCalled()
  })
})
