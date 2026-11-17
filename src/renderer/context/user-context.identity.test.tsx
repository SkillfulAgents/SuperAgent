// @vitest-environment jsdom
import { StrictMode, useEffect } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  session: { data: null, isPending: false } as { data: { user: { id: string; name: string; email: string } } | null; isPending: boolean },
  apiFetch: vi.fn(),
  stash: vi.fn(),
}))
vi.mock('@renderer/lib/auth-client', () => ({ useSession: () => state.session, signOut: vi.fn() }))
vi.mock('@renderer/lib/api', async () => ({
  HttpError: (await import('@renderer/lib/http-error')).HttpError,
  apiFetch: state.apiFetch,
  clearRedirectStash: vi.fn(), markDeliberateSignOut: vi.fn(), clearDeliberateSignOut: vi.fn(),
  stashRedirectTarget: state.stash,
}))
vi.mock('@renderer/components/auth/auth-page', () => ({ AuthPage: () => <div data-testid="signed-out" /> }))
vi.mock('@renderer/components/auth/force-password-change', () => ({ ForcePasswordChange: () => null }))
vi.mock('@renderer/components/auth/workspace-reconnect', () => ({ WorkspaceReconnect: () => null }))
vi.mock('@renderer/lib/meeting-participant-page', () => ({ isMeetingParticipantPage: () => false }))

import { UserProvider, useUser } from './user-context'
import { AuthGate } from '@renderer/components/auth/auth-gate'
import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'

function signedIn(id: string) {
  return { data: { user: { id, name: id, email: `${id}@example.test` } }, isPending: false }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
let client: QueryClient

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('__AUTH_MODE__', true)
  _resetApiTargetForTest()
  setActiveTarget('local', null)
  state.session = signedIn('alice')
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  state.apiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/agents') return json([])
    if (path === '/api/agents/my-roles') return json({ roles: {} })
    throw new Error(`Unexpected API request: ${path}`)
  })
})
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); _resetApiTargetForTest() })

describe('UserProvider identity isolation', () => {
  it('clears every cache family before B mounts, and rebinds role/resolver observers without a logout', async () => {
    const bobRoles = deferred<Response>()
    const bobAgents = deferred<Response>()
    const bobPrivate = deferred<string>()
    client.setQueryData(['agents'], [{ slug: 'private-a', displaySlug: 'alice-private' }])
    client.setQueryData(['my-agent-roles'], { 'private-a': { role: 'owner', memberCount: 1 } })
    client.setQueryData(['private-document'], 'Alice secret')
    client.setQueryData(['user-settings'], { privatePreference: 'Alice only' })
    const seen: Array<{ user: string | undefined; secret: string | undefined; owner: boolean }> = []
    function Probe() {
      const user = useUser()
      const privateDocument = useQuery({ queryKey: ['private-document'], queryFn: () => bobPrivate.promise, staleTime: Infinity })
      useEffect(() => {
        seen.push({ user: user.user?.id, secret: privateDocument.data, owner: user.canAdminAgent('alice-private') })
      }, [user, privateDocument.data])
      return <div data-testid="identity">{user.user?.id}:{privateDocument.data}:{user.canUseAgent('bob-shared') ? 'allowed' : 'denied'}</div>
    }
    const tree = () => <StrictMode><QueryClientProvider client={client}><UserProvider><AuthGate><Probe /></AuthGate></UserProvider></QueryClientProvider></StrictMode>
    const view = render(tree())
    await screen.findByText('alice:Alice secret:denied')
    state.apiFetch.mockImplementation((path: string) => path === '/api/agents' ? bobAgents.promise : bobRoles.promise)
    state.session = signedIn('bob')
    view.rerender(tree())

    await waitFor(() => expect(state.apiFetch).toHaveBeenCalledWith('/api/agents/my-roles'))
    expect(client.getQueryData(['user-settings'])).toBeUndefined()
    expect(seen.some(value => value.user === 'bob' && (value.secret === 'Alice secret' || value.owner))).toBe(false)
    await act(async () => {
      bobAgents.resolve(json([{ slug: 'shared-b', displaySlug: 'bob-shared' }]))
      bobRoles.resolve(json({ roles: { 'shared-b': { role: 'user', memberCount: 2 } } }))
      bobPrivate.resolve('Bob document')
    })
    await screen.findByText('bob:Bob document:allowed')
    expect(client.getQueryData(['agents'])).toEqual([{ slug: 'shared-b', displaySlug: 'bob-shared' }])
  })

  it('keeps AuthGate mounted across logout so the old private URL is not stashed as a cold deep link', async () => {
    const tree = () => <QueryClientProvider client={client}><UserProvider><AuthGate><div data-testid="private-screen" /></AuthGate></UserProvider></QueryClientProvider>
    const view = render(tree())
    expect(screen.getByTestId('private-screen')).toBeVisible()
    state.session = { data: null, isPending: false }
    view.rerender(tree())
    await screen.findByTestId('signed-out')
    expect(state.stash).not.toHaveBeenCalled()
  })

  it('gives a returning identity a new generation after session loss but keeps it stable for a same-user refresh', async () => {
    const generations: object[] = []
    function Probe() {
      const user = useUser()
      useEffect(() => { if (user.user) generations.push(user.authGeneration) }, [user])
      return null
    }
    const tree = () => <QueryClientProvider client={client}><UserProvider><AuthGate><Probe /></AuthGate></UserProvider></QueryClientProvider>
    const view = render(tree())
    await waitFor(() => expect(generations.length).toBeGreaterThan(0))
    const first = generations[0]
    state.session = signedIn('alice')
    view.rerender(tree())
    expect(generations.at(-1)).toBe(first)
    state.session = { data: null, isPending: false }
    view.rerender(tree())
    await screen.findByTestId('signed-out')
    state.session = signedIn('alice')
    view.rerender(tree())
    await waitFor(() => expect(generations.at(-1)).not.toBe(first))
  })
})
