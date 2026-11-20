// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  STREAM_BACKED_POLL_MS,
  STREAM_SILENT_AFTER_MS,
  isNotificationStreamDelivering,
  noteNotificationStreamDown,
  noteNotificationStreamFrame,
  useStreamBackedPollMs,
} from './notification-stream-health'

describe('notification stream health', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    noteNotificationStreamDown()
  })

  afterEach(() => {
    noteNotificationStreamDown()
    vi.useRealTimers()
  })

  it('is not delivering before the server says connected', () => {
    expect(isNotificationStreamDelivering()).toBe(false)
    noteNotificationStreamFrame('ping')
    noteNotificationStreamFrame('agent_updated')
    expect(isNotificationStreamDelivering()).toBe(false)
  })

  it('delivers from connected until the stream goes down', () => {
    noteNotificationStreamFrame('connected')
    expect(isNotificationStreamDelivering()).toBe(true)
    noteNotificationStreamDown()
    expect(isNotificationStreamDelivering()).toBe(false)
    // A frame from before the next greeting proves nothing.
    noteNotificationStreamFrame('ping')
    expect(isNotificationStreamDelivering()).toBe(false)
    noteNotificationStreamFrame('connected')
    expect(isNotificationStreamDelivering()).toBe(true)
  })

  it('stays delivering while the 30 s pings keep arriving', () => {
    noteNotificationStreamFrame('connected')
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(30_000)
      noteNotificationStreamFrame('ping')
      expect(isNotificationStreamDelivering()).toBe(true)
    }
  })

  it('stops delivering when the stream goes silent, and a later frame proves it again', () => {
    noteNotificationStreamFrame('connected')
    vi.advanceTimersByTime(STREAM_SILENT_AFTER_MS - 1_000)
    expect(isNotificationStreamDelivering()).toBe(true)
    // Noticed by the next check, at most 15 s after the silence limit.
    vi.advanceTimersByTime(16_000)
    expect(isNotificationStreamDelivering()).toBe(false)
    noteNotificationStreamFrame('ping')
    expect(isNotificationStreamDelivering()).toBe(true)
  })

  it('notices a silence that passed while timers were not running (a sleeping laptop)', () => {
    noteNotificationStreamFrame('connected')
    vi.setSystemTime(Date.now() + 60 * 60_000)
    vi.advanceTimersByTime(15_000)
    expect(isNotificationStreamDelivering()).toBe(false)
  })

  it('leaves no timer running once the stream is down', () => {
    noteNotificationStreamFrame('connected')
    expect(vi.getTimerCount()).toBe(1)
    noteNotificationStreamDown()
    expect(vi.getTimerCount()).toBe(0)
  })

  describe('useStreamBackedPollMs', () => {
    it('keeps the poll rate without the stream and slows it to the backed rate with it', () => {
      const { result } = renderHook(() => useStreamBackedPollMs(30_000))
      expect(result.current).toBe(30_000)
      act(() => noteNotificationStreamFrame('connected'))
      expect(result.current).toBe(STREAM_BACKED_POLL_MS)
      expect(STREAM_BACKED_POLL_MS).toBe(5 * 60_000)
      act(() => noteNotificationStreamDown())
      expect(result.current).toBe(30_000)
    })

    it('returns to the poll rate when the stream goes silent', () => {
      const { result } = renderHook(() => useStreamBackedPollMs(60_000))
      act(() => noteNotificationStreamFrame('connected'))
      expect(result.current).toBe(STREAM_BACKED_POLL_MS)
      act(() => { vi.advanceTimersByTime(STREAM_SILENT_AFTER_MS + 15_000) })
      expect(result.current).toBe(60_000)
    })

    it('never speeds up a poll that is already slower than the backed rate', () => {
      const { result } = renderHook(() => useStreamBackedPollMs(10 * 60_000))
      act(() => noteNotificationStreamFrame('connected'))
      expect(result.current).toBe(10 * 60_000)
    })
  })
})
