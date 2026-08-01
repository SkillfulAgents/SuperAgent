// @vitest-environment jsdom

import { useEffect, useReducer } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The whole path, end to end: an authenticated cloud session, a request that
 * 401s because the proxy's token re-mint failed, and the UI actually noticing.
 *
 * The unit tests either side of this can both pass while the app stays broken —
 * `apiFetch` returning a 401 and the session store holding its last good value
 * are independently correct, and the bug lives in the gap between them. Signing
 * out (which is what collapses them in web auth mode) is exactly what must not
 * happen here, so nothing joins them unless something is built to.
 */

// A session store that behaves like Better Auth's: it holds its value until
// something re-fetches, and a re-fetch against a dead workspace nulls it.
const sessionStore = {
  data: null as { user: { id: string; name: string; email: string } } | null,
  refetches: 0,
  subscribers: new Set<() => void>(),
  emit() {
    for (const notify of [...this.subscribers]) notify()
  },
}

function useSessionStub() {
  const [, forceRender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    sessionStore.subscribers.add(forceRender)
    return () => {
      sessionStore.subscribers.delete(forceRender)
    }
  }, [])
  return {
    data: sessionStore.data,
    isPending: false,
    refetch: async () => {
      sessionStore.refetches += 1
      // The workspace token is dead, so /api/auth/get-session 401s too and
      // Better Auth nulls the session. This is the real mechanism.
      sessionStore.data = null
      sessionStore.emit()
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
import { _resetCloudSessionForTest } from '@renderer/lib/cloud-session'
import { apiFetch } from '@renderer/lib/api'
import { UserProvider } from '@renderer/context/user-context'
import { AuthGate } from './auth-gate'
import { signOut as authSignOut } from '@renderer/lib/auth-client'

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
  _resetApiTargetForTest()
  setActiveTarget('cloud', null)
  _resetCloudSessionForTest()
  sessionStore.data = { user: { id: 'u1', name: 'Ada', email: 'ada@example.com' } }
  sessionStore.refetches = 0
  sessionStore.subscribers.clear()
  vi.mocked(authSignOut).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  _resetApiTargetForTest()
  _resetCloudSessionForTest()
})

describe('a cloud workspace session going dead mid-use', () => {
  it('replaces the app with the reconnect screen', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }))
    renderApp()

    // Authenticated: the app is up.
    expect(screen.getByTestId('app')).toBeInTheDocument()

    // A background query hits the dead workspace.
    await apiFetch('/api/agents')

    await waitFor(() => {
      expect(screen.queryByTestId('app')).not.toBeInTheDocument()
    })
    expect(screen.getByText(/Can’t reach your cloud workspace/)).toBeInTheDocument()
  })

  it('never signs out on the way there', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }))
    renderApp()

    await apiFetch('/api/agents')
    await waitFor(() => expect(sessionStore.refetches).toBeGreaterThan(0))

    // signOut() would revoke the deployment session the desktop's grant is
    // bound to — and there is no password to sign back in with.
    expect(authSignOut).not.toHaveBeenCalled()
  })

  it('never offers a password form for a workspace credential', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }))
    renderApp()

    await apiFetch('/api/agents')

    await waitFor(() => {
      expect(screen.queryByTestId('app')).not.toBeInTheDocument()
    })
    expect(screen.queryByTestId('auth-page')).not.toBeInTheDocument()
  })

  it('leaves the app alone when the request succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))
    renderApp()

    await apiFetch('/api/agents')

    expect(sessionStore.refetches).toBe(0)
    expect(screen.getByTestId('app')).toBeInTheDocument()
  })

  it('re-checks the session once for a burst of failures, not once each', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }))
    renderApp()

    await Promise.all([
      apiFetch('/api/agents'),
      apiFetch('/api/sessions'),
      apiFetch('/api/settings'),
      apiFetch('/api/notifications'),
    ])

    await waitFor(() => expect(sessionStore.refetches).toBe(1))
  })
})
