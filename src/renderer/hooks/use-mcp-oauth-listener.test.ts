// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMcpOAuthListener } from './use-mcp-oauth-listener'

// Ensure no electronAPI so we test the postMessage path
vi.stubGlobal('electronAPI', undefined)
Object.defineProperty(window, 'electronAPI', { value: undefined, writable: true })

const broadcastChannels: FakeBroadcastChannel[] = []

class FakeBroadcastChannel {
  listeners = new Set<(event: MessageEvent) => void>()
  close = vi.fn()

  constructor(public name: string) {
    broadcastChannels.push(this)
  }

  addEventListener(type: string, listener: EventListener) {
    if (type === 'message') {
      this.listeners.add(listener as (event: MessageEvent) => void)
    }
  }

  removeEventListener(type: string, listener: EventListener) {
    if (type === 'message') {
      this.listeners.delete(listener as (event: MessageEvent) => void)
    }
  }

  dispatch(data: unknown) {
    for (const listener of this.listeners) {
      listener(new MessageEvent('message', { data }))
    }
  }
}

vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)

function firePostMessage(data: unknown, origin: string) {
  const event = new MessageEvent('message', { data, origin })
  window.dispatchEvent(event)
}

function fireStorageMessage(data: unknown) {
  window.dispatchEvent(new StorageEvent('storage', {
    key: 'superagent.mcp-oauth-callback',
    newValue: JSON.stringify(data),
  }))
}

describe('useMcpOAuthListener', () => {
  afterEach(() => {
    broadcastChannels.length = 0
    vi.restoreAllMocks()
  })

  it('calls onComplete for same-origin mcp-oauth-callback messages', () => {
    const onComplete = vi.fn()
    renderHook(() => useMcpOAuthListener(true, onComplete))

    firePostMessage(
      { type: 'mcp-oauth-callback', success: true },
      window.location.origin,
    )

    expect(onComplete).toHaveBeenCalledWith({ success: true, error: undefined })
  })

  it('preserves the completed connection ID for replacement selection', () => {
    const onComplete = vi.fn()
    renderHook(() => useMcpOAuthListener(true, onComplete))
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'mcp-oauth-callback', success: true, mcpId: 'new-mcp' },
      }))
    })
    expect(onComplete).toHaveBeenCalledWith({ success: true, error: undefined, mcpId: 'new-mcp' })
  })

  it('calls onComplete for BroadcastChannel mcp-oauth-callback messages', () => {
    const onComplete = vi.fn()
    renderHook(() => useMcpOAuthListener(true, onComplete))

    broadcastChannels[0].dispatch(
      { type: 'mcp-oauth-callback', success: true },
    )

    expect(broadcastChannels[0].name).toBe('mcp-oauth-callback')
    expect(onComplete).toHaveBeenCalledWith({ success: true, error: undefined })
  })

  it('calls onComplete for localStorage storage fallback messages', () => {
    const onComplete = vi.fn()
    renderHook(() => useMcpOAuthListener(true, onComplete))

    fireStorageMessage(
      { type: 'mcp-oauth-callback', success: true },
    )

    expect(onComplete).toHaveBeenCalledWith({ success: true, error: undefined })
  })

  it('only completes once if multiple callback delivery mechanisms fire', () => {
    const onComplete = vi.fn()
    renderHook(() => useMcpOAuthListener(true, onComplete))

    const payload = { type: 'mcp-oauth-callback', success: true }
    broadcastChannels[0].dispatch(payload)
    firePostMessage(payload, window.location.origin)
    fireStorageMessage(payload)

    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it.each(['postMessage', 'broadcast', 'storage', 'electron'] as const)('correlates %s callbacks before consuming the listener', (transport) => {
    let electronCallback: ((params: Record<string, unknown>) => void) | undefined
    const unsubscribe = vi.fn()
    if (transport === 'electron') {
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
        onMcpOAuthCallback: (callback: typeof electronCallback) => { electronCallback = callback; return unsubscribe },
      } })
    }
    try {
      const onComplete = vi.fn()
      const { unmount } = renderHook(() => useMcpOAuthListener(true, onComplete, 'own-flow'))
      const dispatch = (data: Record<string, unknown>) => {
        const payload = { type: 'mcp-oauth-callback', ...data }
        if (transport === 'postMessage') firePostMessage(payload, window.location.origin)
        if (transport === 'broadcast') broadcastChannels[0].dispatch(payload)
        if (transport === 'storage') fireStorageMessage(payload)
        if (transport === 'electron') electronCallback?.(payload)
      }
      dispatch({ success: true, state: 'other-flow', mcpId: 'wrong-mcp' })
      dispatch({ success: false, state: 'other-flow', error: 'Other flow failed' })
      dispatch({ success: true, mcpId: 'missing-state' })
      expect(onComplete).not.toHaveBeenCalled()
      dispatch({ success: true, state: 'own-flow', mcpId: 'correct-mcp' })
      dispatch({ success: true, state: 'own-flow', mcpId: 'correct-mcp' })
      expect(onComplete).toHaveBeenCalledExactlyOnceWith({ success: true, error: undefined, state: 'own-flow', mcpId: 'correct-mcp' })
      unmount()
      if (transport === 'electron') expect(unsubscribe).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined, writable: true })
    }
  })

  it('delivers a failure for its own OAuth state', () => {
    const onComplete = vi.fn()
    renderHook(() => useMcpOAuthListener(true, onComplete, 'own-flow'))
    fireStorageMessage({ type: 'mcp-oauth-callback', success: false, state: 'own-flow', error: 'Access denied' })
    expect(onComplete).toHaveBeenCalledWith({ success: false, state: 'own-flow', error: 'Access denied' })
  })

  it('ignores mcp-oauth-callback messages from a different origin', () => {
    const onComplete = vi.fn()
    renderHook(() => useMcpOAuthListener(true, onComplete))

    firePostMessage(
      { type: 'mcp-oauth-callback', success: true },
      'https://evil.example.com',
    )

    expect(onComplete).not.toHaveBeenCalled()
  })

  it('ignores messages when not active', () => {
    const onComplete = vi.fn()
    renderHook(() => useMcpOAuthListener(false, onComplete))

    firePostMessage(
      { type: 'mcp-oauth-callback', success: true },
      window.location.origin,
    )

    expect(onComplete).not.toHaveBeenCalled()
  })

  it('ignores messages with unrelated type', () => {
    const onComplete = vi.fn()
    renderHook(() => useMcpOAuthListener(true, onComplete))

    firePostMessage(
      { type: 'some-other-callback', success: true },
      window.location.origin,
    )

    expect(onComplete).not.toHaveBeenCalled()
  })

  it('passes error field through on failure', () => {
    const onComplete = vi.fn()
    renderHook(() => useMcpOAuthListener(true, onComplete))

    firePostMessage(
      { type: 'mcp-oauth-callback', success: false, error: 'token expired' },
      window.location.origin,
    )

    expect(onComplete).toHaveBeenCalledWith({ success: false, error: 'token expired' })
  })
})
