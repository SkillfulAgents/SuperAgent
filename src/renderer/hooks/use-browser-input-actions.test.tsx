// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DraftsProvider } from '@renderer/context/drafts-context'
import { useBrowserInputActions } from './use-browser-input-actions'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const ok = () => ({ ok: true, json: () => Promise.resolve({}) })
const COMPLETE_URL = '/api/agents/a/sessions/s/complete-browser-input'
const MESSAGES_URL = '/api/agents/a/sessions/s/messages'

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { gcTime: Infinity } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}><DraftsProvider>{children}</DraftsProvider></QueryClientProvider>
  }
}

const scope = { agentSlug: 'a', sessionId: 's', toolUseId: 'tu-1' }

function setup(onResolved = vi.fn()) {
  const view = renderHook(
    (request) => useBrowserInputActions({ ...request, onResolved }),
    { wrapper: wrapper(), initialProps: scope }
  )
  return { ...view, onResolved }
}

describe('useBrowserInputActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('complete posts only the toolUseId and resolves it', async () => {
    mockApiFetch.mockResolvedValueOnce(ok())
    const { result, onResolved } = setup()

    await act(async () => {
      await result.current.complete()
    })

    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockApiFetch.mock.calls[0][0]).toBe(COMPLETE_URL)
    expect(JSON.parse(mockApiFetch.mock.calls[0][1].body)).toEqual({ toolUseId: 'tu-1' })
    await waitFor(() => expect(result.current.status).toBe('completed'))
    expect(result.current.submittingAction).toBeNull()
    expect(onResolved).toHaveBeenCalledWith('tu-1')
  })

  it('decline with no reason posts only the decline, no /messages', async () => {
    mockApiFetch.mockResolvedValueOnce(ok())
    const { result, onResolved } = setup()

    await act(async () => {
      await result.current.decline()
    })

    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(mockApiFetch.mock.calls[0][1].body)).toEqual({ toolUseId: 'tu-1', decline: true })
    await waitFor(() => expect(result.current.status).toBe('declined'))
    expect(result.current.submittingAction).toBeNull()
    expect(onResolved).toHaveBeenCalledWith('tu-1')
  })

  it('decline with a reason declines, then posts the reason to /messages in order', async () => {
    mockApiFetch.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok())
    const { result } = setup()

    await act(async () => {
      await result.current.decline('skip the login')
    })

    expect(mockApiFetch).toHaveBeenCalledTimes(2)
    expect(mockApiFetch.mock.calls[0][0]).toBe(COMPLETE_URL)
    expect(JSON.parse(mockApiFetch.mock.calls[0][1].body)).toEqual({ toolUseId: 'tu-1', decline: true })
    expect(mockApiFetch.mock.calls[1][0]).toBe(MESSAGES_URL)
    expect(JSON.parse(mockApiFetch.mock.calls[1][1].body)).toEqual({ content: 'skip the login' })
  })

  it('when the decline itself fails, it never posts the reason and reverts to pending', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'decline boom' }),
    })
    const { result, onResolved } = setup()

    await act(async () => {
      await result.current.decline('skip the login')
    })

    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('pending')
    await waitFor(() => expect(result.current.error).toMatch(/decline boom/))
    expect(onResolved).not.toHaveBeenCalled()
  })

  it.each(['complete', 'decline'] as const)('starts the next request fresh after %s without remounting', async (action) => {
    mockApiFetch.mockResolvedValue(ok())
    const { result, rerender } = setup()

    await act(async () => { await result.current[action]() })
    await waitFor(() => expect(result.current.status).toBe(action === 'complete' ? 'completed' : 'declined'))

    rerender({ ...scope, toolUseId: 'tu-2' })
    expect(result.current.status).toBe('pending')
    expect(result.current.submittingAction).toBeNull()
    expect(result.current.error).toBeNull()

    await act(async () => { await result.current.complete() })
    expect(JSON.parse(mockApiFetch.mock.calls[1][1].body)).toEqual({ toolUseId: 'tu-2' })
  })

  it('shares in-flight and resolved state across surfaces and blocks simultaneous submissions', async () => {
    let resolve!: (value: ReturnType<typeof ok>) => void
    mockApiFetch.mockReturnValueOnce(new Promise((res) => { resolve = res }))
    const onThreadResolved = vi.fn()
    const onTrayResolved = vi.fn()
    const { result } = renderHook(() => ({
      thread: useBrowserInputActions({ ...scope, onResolved: onThreadResolved }),
      tray: useBrowserInputActions({ ...scope, onResolved: onTrayResolved }),
    }), { wrapper: wrapper() })

    let pending!: Promise<boolean>
    await act(async () => {
      pending = result.current.tray.complete()
      await result.current.thread.decline()
    })
    await waitFor(() => expect(result.current.thread.status).toBe('submitting'))
    expect(result.current.tray.status).toBe('submitting')
    expect(result.current.thread.submittingAction).toBe('completing')
    expect(mockApiFetch).toHaveBeenCalledTimes(1)

    await act(async () => { resolve(ok()); await pending })
    await waitFor(() => expect(result.current.thread.status).toBe('completed'))
    expect(result.current.tray.status).toBe('completed')
    expect(result.current.thread.submittingAction).toBeNull()
    expect(result.current.tray.submittingAction).toBeNull()
    expect(onThreadResolved).toHaveBeenCalledExactlyOnceWith('tu-1')
    expect(onTrayResolved).toHaveBeenCalledExactlyOnceWith('tu-1')

    await act(async () => { await result.current.thread.complete() })
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
  })

  it('shares failures and allows a retry from the other surface', async () => {
    mockApiFetch
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Try again' }) })
      .mockResolvedValueOnce(ok())
    const { result } = renderHook(() => ({
      thread: useBrowserInputActions({ ...scope, onResolved: vi.fn() }),
      tray: useBrowserInputActions({ ...scope, onResolved: vi.fn() }),
    }), { wrapper: wrapper() })

    await act(async () => { await result.current.tray.complete() })
    await waitFor(() => expect(result.current.thread.error).toBe('Try again'))
    expect(result.current.tray.error).toBe('Try again')
    expect(result.current.thread.status).toBe('pending')
    expect(result.current.tray.status).toBe('pending')

    await act(async () => { await result.current.thread.complete() })
    await waitFor(() => expect(result.current.tray.status).toBe('completed'))
    expect(result.current.thread.error).toBeNull()
    expect(result.current.tray.error).toBeNull()
  })

  it.each([
    { ...scope, toolUseId: 'tu-2' },
    { ...scope, sessionId: 's-2' },
    { ...scope, agentSlug: 'b' },
  ])('does not apply a late response to a different request scope: %j', async (nextScope) => {
    let resolve!: (value: ReturnType<typeof ok>) => void
    mockApiFetch.mockReturnValueOnce(new Promise((res) => { resolve = res }))
    const { result, rerender, onResolved } = setup()
    let pending!: Promise<boolean>
    act(() => { pending = result.current.complete() })
    await waitFor(() => expect(result.current.status).toBe('submitting'))

    rerender(nextScope)
    expect(result.current.status).toBe('pending')
    expect(result.current.submittingAction).toBeNull()

    await act(async () => { resolve(ok()); await pending })
    expect(result.current.status).toBe('pending')
    expect(onResolved).not.toHaveBeenCalled()

    rerender(scope)
    expect(result.current.status).toBe('completed')
    expect(onResolved).toHaveBeenCalledExactlyOnceWith('tu-1')
  })
})
