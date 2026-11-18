// @vitest-environment jsdom

import { useEffect, useReducer } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A cloud workspace that doesn't answer `get-session` (restarting for an
 * upgrade, waking, a network blip) has an unknown session, not a dead one. The
 * app should wait and retry, and keep the reconnect screen for a real "no".
 */

type SessionError = { status: number; state?: string }
type SessionUser = { id: string; name: string; email: string }

// Mirrors Better Auth's session atom: a request sets isPending (data is null)
// and clears error; a non-401 failure leaves data as it was.
const store = {
  data: null as { user: SessionUser } | null,
  error: null as SessionError | null,
  isPending: true,
  refetches: 0,
  pendingRefetch: null as ((result: { user?: SessionUser; error?: SessionError }) => void) | null,
  subscribers: new Set<() => void>(),
  emit() {
    for (const notify of [...this.subscribers]) notify()
  },
  settle(result: { user?: SessionUser; error?: SessionError }) {
    this.data = result.user ? { user: result.user } : result.error ? this.data : null
    this.error = result.error ?? null
    this.isPending = false
    this.emit()
  },
}

function useSessionStub() {
  const [, forceRender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    store.subscribers.add(forceRender)
    return () => {
      store.subscribers.delete(forceRender)
    }
  }, [])
  return {
    data: store.data,
    error: store.error,
    isPending: store.isPending,
    refetch: () => {
      store.refetches += 1
      store.isPending = store.data === null
      store.error = null
      store.emit()
      return new Promise<void>((resolve) => {
        store.pendingRefetch = (result) => {
          store.settle(result)
          resolve()
        }
      })
    },
  }
}

vi.mock('@renderer/lib/auth-client', () => ({
  useSession: useSessionStub,
  signOut: vi.fn(),
  authClient: {},
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: undefined }),
  resolveRouteAgentId: (slug: string) => slug,
}))

vi.mock('./auth-page', () => ({ AuthPage: () => <div data-testid="auth-page" /> }))
vi.mock('./force-password-change', () => ({ ForcePasswordChange: () => <div /> }))

import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'
import { UserProvider } from '@renderer/context/user-context'
import { AuthGate } from './auth-gate'

const ada = { id: 'u1', name: 'Ada', email: 'ada@example.com' }

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <UserProvider>
        <AuthGate>
          <div data-testid="app">the app</div>
        </AuthGate>
      </UserProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.stubGlobal('__AUTH_MODE__', false)
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('[]', { status: 200 })))
  _resetApiTargetForTest()
  setActiveTarget('cloud', null)
  store.data = null
  store.error = null
  store.isPending = true
  store.refetches = 0
  store.pendingRefetch = null
  store.subscribers.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  _resetApiTargetForTest()
})

describe('a cloud workspace that does not answer the session check', () => {
  it('waits through a restart and opens the app once the workspace is back', async () => {
    renderApp()
    act(() => store.settle({ error: { status: 503, state: 'waking' } }))

    expect(screen.getByText('Starting your cloud workspace…')).toBeInTheDocument()
    expect(screen.queryByText(/Can’t reach your cloud workspace/)).not.toBeInTheDocument()

    // The retry is in flight: the waiting screen stays instead of flashing "Loading...".
    await waitFor(() => expect(store.refetches).toBe(1), { timeout: 4_000 })
    expect(screen.getByText('Starting your cloud workspace…')).toBeInTheDocument()
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()

    act(() => store.pendingRefetch?.({ user: ada }))

    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument())
  })

  it('says reconnecting when the router gives no route state', () => {
    renderApp()
    act(() => store.settle({ error: { status: 502 } }))

    expect(screen.getByText('Reconnecting to your cloud workspace…')).toBeInTheDocument()
  })

  it('keeps the reconnect screen for a rejected token', () => {
    renderApp()
    act(() => store.settle({ error: { status: 401 } }))

    expect(screen.getByText(/Can’t reach your cloud workspace/)).toBeInTheDocument()
  })

  it('keeps the reconnect screen when the workspace answers with no session', () => {
    renderApp()
    act(() => store.settle({}))

    expect(screen.getByText(/Can’t reach your cloud workspace/)).toBeInTheDocument()
  })
})
