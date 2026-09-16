// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// A test can hold the next /initiate open so a launch stays pending.
const initiateGate = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  onEnter: null as (() => void) | null,
}))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/api/platform-auth') return { ok: true, json: async () => ({ connected: true, updatedAt: 't1' }) }
    if (path.endsWith('/initiate')) {
      const hold = initiateGate.hold
      initiateGate.hold = null
      initiateGate.onEnter?.()
      if (hold) await hold
      return { ok: true, json: async () => ({ loginUrl: 'https://platform.test/login' }) }
    }
    return { ok: true, json: async () => ({}) }
  }),
}))

const popupMocks = vi.hoisted(() => ({ navigate: vi.fn(async () => {}), close: vi.fn() }))
vi.mock('@renderer/lib/oauth-popup', () => ({
  prepareOAuthPopup: () => ({ navigate: popupMocks.navigate, close: popupMocks.close }),
}))

import { usePlatformConnect } from './use-platform-auth'
import { OAUTH_ABORT_DELAY_MS } from './use-delayed-oauth-abort'

async function renderConnected() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => usePlatformConnect(), { wrapper })
  await waitFor(() => expect(result.current.isConnected).toBe(true))
  return { result, client }
}

async function renderLaunched({ fakeTimers = false } = {}) {
  const rendered = await renderConnected()
  // Only the launch itself runs under fake timers; waitFor needs real ones.
  if (fakeTimers) vi.useFakeTimers()
  await act(async () => { await rendered.result.current.handleConnect() })
  expect(rendered.result.current.isLaunching).toBe(true)
  return rendered
}

// Web mode: the login callback never arrives here (the deep link lands in the
// desktop app), so a saved token or the user's Cancel are the only things that
// can end a launch.
describe('usePlatformConnect launching state in a browser window', () => {
  afterEach(() => {
    vi.useRealTimers()
    initiateGate.hold = null
    initiateGate.onEnter = null
    popupMocks.close.mockReset()
    popupMocks.navigate.mockClear()
  })

  it('ends the launch when the stored token changes by any path', async () => {
    const { result, client } = await renderLaunched()

    // An access key saved meanwhile: the status query carries a new updatedAt.
    act(() => { client.setQueryData(['platform-auth'], { connected: true, updatedAt: 't2' }) })
    await waitFor(() => expect(result.current.isLaunching).toBe(false))
  })

  it('offers Cancel after the delay, and Cancel closes the window and ends the launch', async () => {
    const { result } = await renderLaunched({ fakeTimers: true })

    act(() => { vi.advanceTimersByTime(OAUTH_ABORT_DELAY_MS - 1) })
    expect(result.current.canCancel).toBe(false)

    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current.canCancel).toBe(true)

    act(() => { result.current.cancelConnect() })
    expect(popupMocks.close).toHaveBeenCalledTimes(1)
    expect(result.current.isLaunching).toBe(false)
    expect(result.current.canCancel).toBe(false)
  })

  it('drops a launch request that resolves after Cancel', async () => {
    const { result } = await renderConnected()
    let release!: () => void
    initiateGate.hold = new Promise<void>((resolve) => { release = resolve })
    const initiatePending = new Promise<void>((resolve) => { initiateGate.onEnter = resolve })

    let launch!: Promise<void>
    act(() => { launch = result.current.handleConnect() })
    await act(async () => { await initiatePending })

    act(() => { result.current.cancelConnect() })
    expect(result.current.isLaunching).toBe(false)

    release()
    await act(async () => { await launch })
    expect(popupMocks.navigate).not.toHaveBeenCalled()
    expect(result.current.isLaunching).toBe(false)
  })

  it('lets a launch that ended early fail late without touching the retry started after it', async () => {
    const { result, client } = await renderConnected()
    let fail!: () => void
    initiateGate.hold = new Promise<void>((_, reject) => { fail = () => reject(new Error('late failure')) })
    const initiatePending = new Promise<void>((resolve) => { initiateGate.onEnter = resolve })

    let first!: Promise<void>
    act(() => { first = result.current.handleConnect() })
    await act(async () => { await initiatePending })

    // An access key saved while the first request is still pending ends that launch...
    act(() => { client.setQueryData(['platform-auth'], { connected: true, updatedAt: 't2' }) })
    await waitFor(() => expect(result.current.isLaunching).toBe(false))

    // ...and the user launches again. The first request then fails.
    await act(async () => { await result.current.handleConnect() })
    expect(result.current.isLaunching).toBe(true)
    fail()
    await act(async () => { await first })

    expect(result.current.isLaunching).toBe(true)
    expect(result.current.error).toBeNull()
    expect(popupMocks.navigate).toHaveBeenCalledTimes(1)
  })
})
