// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
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

// user-context reads __AUTH_MODE__ at module scope — stub before the import runs.
const { useSessionMock } = vi.hoisted(() => {
  vi.stubGlobal('__AUTH_MODE__', true)
  return { useSessionMock: vi.fn() }
})
vi.mock('@renderer/lib/auth-client', () => ({
  useSession: useSessionMock,
  signOut: vi.fn(),
}))

import { UserProvider } from './user-context'

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
