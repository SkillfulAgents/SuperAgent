// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMcpOAuthListener } from './use-mcp-oauth-listener'

// Ensure no electronAPI so we test the postMessage path
vi.stubGlobal('electronAPI', undefined)
Object.defineProperty(window, 'electronAPI', { value: undefined, writable: true })

function firePostMessage(data: unknown, origin: string) {
  const event = new MessageEvent('message', { data, origin })
  window.dispatchEvent(event)
}

describe('useMcpOAuthListener', () => {
  afterEach(() => {
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
