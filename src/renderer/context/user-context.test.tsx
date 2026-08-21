// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Capture every useQuery options object so we can assert the `enabled` gates.
const capturedOptions: Record<string, unknown>[] = []

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: ((options: Record<string, unknown>) => {
      capturedOptions.push(options)
      return { data: undefined, isLoading: false, isError: false, isFetched: false }
    }) as unknown as typeof actual.useQuery,
  }
})

// Auth mode is derived per render now, but the build-time constant still feeds
// it — stub before the import runs so both paths see a consistent value.
const { useSessionMock } = vi.hoisted(() => {
  vi.stubGlobal('__AUTH_MODE__', true)
  return { useSessionMock: vi.fn() }
})
vi.mock('@renderer/lib/auth-client', () => ({
  useSession: useSessionMock,
  signOut: vi.fn(),
}))

import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'
import { UserProvider, useUser, type UserContextValue } from './user-context'

function renderProvider() {
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <UserProvider>
        <div />
      </UserProvider>
    </QueryClientProvider>,
  )
}

function agentsQueryOptions() {
  return capturedOptions.find(
    (o) => Array.isArray(o.queryKey) && o.queryKey.length === 1 && o.queryKey[0] === 'agents',
  )
}

// While signed out, /api/agents 401s; the apiFetch handler then signs out again,
// better-auth refetches get-session, and AuthGate flashes Loading/AuthPage in a
// loop as React Query retries. The query must stay disabled until authenticated.
describe('UserProvider agents resolver query gating (auth mode)', () => {
  beforeEach(() => {
    capturedOptions.length = 0
  })

  it('disables the agents query while signed out', () => {
    useSessionMock.mockReturnValue({ data: null, isPending: false })
    renderProvider()
    expect(agentsQueryOptions()?.enabled).toBe(false)
  })

  it('disables the agents query while the session check is pending', () => {
    useSessionMock.mockReturnValue({ data: null, isPending: true })
    renderProvider()
    expect(agentsQueryOptions()?.enabled).toBe(false)
  })

  it('enables the agents query once authenticated', () => {
    useSessionMock.mockReturnValue({
      data: { user: { id: 'u1', name: 'U', email: 'u@x.com' } },
      isPending: false,
    })
    renderProvider()
    expect(agentsQueryOptions()?.enabled).toBe(true)
  })
})

describe('UserProvider against a cloud workspace', () => {
  // A cloud workspace is an auth-mode deployment, but every Electron build
  // compiles __AUTH_MODE__ to false. Before this phase that combination made the
  // UI claim no user, no admin, and full capability on every agent — so the app
  // offered every action and the user met their real permissions as 403s.
  let seen: UserContextValue | null = null

  function Probe() {
    seen = useUser()
    return null
  }

  function renderWithProbe() {
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <UserProvider>
          <Probe />
        </UserProvider>
      </QueryClientProvider>,
    )
  }

  beforeEach(() => {
    capturedOptions.length = 0
    seen = null
    vi.stubGlobal('__AUTH_MODE__', false)
    _resetApiTargetForTest()
    setActiveTarget('cloud', null)
    useSessionMock.mockReturnValue({ data: null, isPending: false })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    _resetApiTargetForTest()
  })

  it('reports auth mode on, despite a build compiled with it off', () => {
    renderWithProbe()
    expect(seen?.isAuthMode).toBe(true)
  })

  it('consults the session instead of assuming there is no user', () => {
    renderWithProbe()
    // The conditional hook took the auth branch.
    expect(useSessionMock).toHaveBeenCalled()
  })

  it('withholds agent capabilities until roles say otherwise', () => {
    renderWithProbe()
    // The pre-phase behaviour was `true` for all three, on every agent.
    expect(seen?.canAccessAgent('some-agent')).toBe(false)
    expect(seen?.canUseAgent('some-agent')).toBe(false)
    expect(seen?.canAdminAgent('some-agent')).toBe(false)
  })

  it('grants capabilities once the session and roles arrive', () => {
    useSessionMock.mockReturnValue({
      data: { user: { id: 'u1', name: 'A', email: 'a@b.c', role: 'admin' } },
      isPending: false,
    })
    renderWithProbe()

    expect(seen?.isAuthenticated).toBe(true)
    expect(seen?.isAdmin).toBe(true)
  })

  it('keeps reporting the same auth mode across re-renders', () => {
    // Hooks are called conditionally on this value; a flip mid-lifetime would
    // reorder them and crash the tree.
    renderWithProbe()
    const first = seen?.isAuthMode
    useSessionMock.mockReturnValue({
      data: { user: { id: 'u1', name: 'A', email: 'a@b.c' } },
      isPending: false,
    })
    renderWithProbe()
    expect(seen?.isAuthMode).toBe(first)
  })
})
