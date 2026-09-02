// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STREAM_RECONNECT_MAX_MS,
  STREAM_RECONNECT_MS,
  reconnectDelayMs,
  watchStreamLiveness,
} from './stream-liveness'

class FakeEventSource extends EventTarget {
  readyState = 0
}

describe('reconnectDelayMs', () => {
  it('doubles from the base and caps', () => {
    expect(reconnectDelayMs(0)).toBe(STREAM_RECONNECT_MS)
    expect(reconnectDelayMs(1)).toBe(STREAM_RECONNECT_MS * 2)
    expect(reconnectDelayMs(4)).toBe(STREAM_RECONNECT_MS * 16)
    expect(reconnectDelayMs(5)).toBe(STREAM_RECONNECT_MAX_MS)
    expect(reconnectDelayMs(40)).toBe(STREAM_RECONNECT_MAX_MS)
  })
})

describe('watchStreamLiveness', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', { CONNECTING: 0, OPEN: 1, CLOSED: 2 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls onDead once for error at readyState 2', () => {
    const es = new FakeEventSource()
    es.readyState = EventSource.CLOSED
    const onDead = vi.fn()
    watchStreamLiveness(es, onDead)

    es.dispatchEvent(new Event('error'))
    es.dispatchEvent(new Event('error'))

    expect(onDead).toHaveBeenCalledOnce()
  })

  it('does not call onDead for error at readyState 0', () => {
    const es = new FakeEventSource()
    es.readyState = EventSource.CONNECTING
    const onDead = vi.fn()
    watchStreamLiveness(es, onDead)

    es.dispatchEvent(new Event('error'))

    expect(onDead).not.toHaveBeenCalled()
  })

  it('does not call onDead after dispose', () => {
    const es = new FakeEventSource()
    es.readyState = EventSource.CLOSED
    const onDead = vi.fn()
    const dispose = watchStreamLiveness(es, onDead)

    dispose()
    es.dispatchEvent(new Event('error'))

    expect(onDead).not.toHaveBeenCalled()
  })
})
