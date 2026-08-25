// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}))

vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.apiFetch }))

import { useKeepAlive } from './use-keep-alive'

describe('useKeepAlive', () => {
  let visibilityState: DocumentVisibilityState

  beforeEach(() => {
    visibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState)
    mocks.apiFetch.mockResolvedValue(new Response(null, { status: 200 }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('refreshes the dashboard lease immediately after a hidden tab becomes visible', () => {
    const { unmount } = renderHook(() => useKeepAlive('agent-a'))

    expect(mocks.apiFetch).toHaveBeenCalledOnce()
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      '/api/agents/agent-a/keep-alive',
      { method: 'POST' },
    )

    visibilityState = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(mocks.apiFetch).toHaveBeenCalledOnce()

    visibilityState = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)

    unmount()
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
  })
})
