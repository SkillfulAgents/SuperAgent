// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { STREAM_RECONNECT_MAX_MS, STREAM_RECONNECT_MS, reconnectDelayMs } from './stream-liveness'

describe('reconnectDelayMs', () => {
  it('doubles from the base and caps', () => {
    expect(reconnectDelayMs(0)).toBe(STREAM_RECONNECT_MS)
    expect(reconnectDelayMs(1)).toBe(STREAM_RECONNECT_MS * 2)
    expect(reconnectDelayMs(4)).toBe(STREAM_RECONNECT_MS * 16)
    expect(reconnectDelayMs(5)).toBe(STREAM_RECONNECT_MAX_MS)
    expect(reconnectDelayMs(40)).toBe(STREAM_RECONNECT_MAX_MS)
  })
})
