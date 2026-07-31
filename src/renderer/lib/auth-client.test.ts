// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// This file tests the real module, not the global stub from test/setup.ts.
vi.unmock('@renderer/lib/auth-client')

const { createAuthClient, baseUrl, remote } = vi.hoisted(() => ({
  remote: { value: false },
  createAuthClient: vi.fn((_options: { baseURL?: string; fetchOptions?: { credentials?: string } }) => ({
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
    useSession: vi.fn(() => ({ data: null, isPending: false })),
    admin: { listUsers: vi.fn() },
    changePassword: vi.fn(),
  })),
  baseUrl: { value: '' },
}))

vi.mock('better-auth/react', () => ({ createAuthClient }))
vi.mock('better-auth/client/plugins', () => ({
  adminClient: () => ({ id: 'admin' }),
  genericOAuthClient: () => ({ id: 'oauth' }),
}))
vi.mock('./env', () => ({ getApiBaseUrl: () => baseUrl.value }))
vi.mock('./api-target', () => ({ targetIsRemote: () => remote.value }))

import { _resetAuthClientForTest, authClient, signOut, useSession } from './auth-client'

// Captured HERE, at module scope, before any beforeEach can clear the spy or
// reset the module. Asserting this inside a test would prove nothing: the
// import-time call would already have been wiped, and an eagerly-built client
// would look identical to a lazy one.
const buildsDuringImport = createAuthClient.mock.calls.length

/**
 * The client's baseURL has to be the same base every other call site prefixes,
 * and in cloud mode that is the keyed proxy prefix — which the main process only
 * reveals during `initApiBaseUrl()`. This module is imported while the module
 * graph is still evaluating, before that runs, so construction must be deferred
 * or every session lookup in cloud mode resolves against the wrong Superagent.
 */

beforeEach(() => {
  createAuthClient.mockClear()
  _resetAuthClientForTest()
  baseUrl.value = ''
  remote.value = false
})

afterEach(() => {
  _resetAuthClientForTest()
})

describe('construction timing', () => {
  it('does not build the client just because the module was imported', () => {
    // Importing happens before the API target is known. Building here would
    // capture the wrong base URL permanently — in cloud mode, the local API.
    expect(buildsDuringImport).toBe(0)
  })

  it('builds it on first use, reading the base URL as it stands then', () => {
    baseUrl.value = 'http://localhost:3000/cloud/KEY123'

    useSession()

    expect(createAuthClient).toHaveBeenCalledOnce()
    expect(createAuthClient.mock.calls[0][0]).toMatchObject({
      baseURL: 'http://localhost:3000/cloud/KEY123/api/auth',
    })
  })

  it('builds only once across many uses', () => {
    baseUrl.value = 'http://localhost:3000'

    useSession()
    signOut()
    void authClient.admin

    expect(createAuthClient).toHaveBeenCalledOnce()
  })
})

/**
 * better-auth appends its default `/api/auth` only to a base URL that has no
 * path of its own — `withPath()` returns the URL untouched once `checkHasPath()`
 * is true. A local base is a bare origin and so gets the default for free; a
 * cloud base is `http://host:port/cloud/{key}`, which already has a path, so it
 * does not. Passing the raw base therefore sent every call to
 * `/cloud/{key}/get-session`, which 404s — and a 404 there is indistinguishable
 * from a dead session, so the app showed "can't reach your cloud workspace"
 * against a workspace that was answering fine.
 *
 * The invariant, then, is not "pass the base URL" but "pass the *auth* base",
 * and it has to hold for every mode rather than only the one that used to work
 * by accident.
 */
/**
 * A credentialed cross-origin request forbids the server answering with a
 * wildcard `Access-Control-Allow-Origin`, and the local API answers exactly
 * that (its CORS is `*` — there is no TRUSTED_ORIGINS on a desktop install). So
 * in cloud mode `credentials: 'include'` gets `get-session` blocked by the
 * browser before it is sent, `isAuthenticated` goes false, and `AuthGate` shows
 * "can't reach your cloud workspace" over a workspace that is answering fine.
 *
 * Omitting them costs nothing there: the session belongs to the deployment and
 * is injected by the proxy from the main process, and this renderer holds no
 * cookie scoped to the deployment's origin.
 *
 * Only a renderer with a real HTTP origin is subject to this — `electron-vite
 * dev` serves one from `http://localhost:5173`, a packaged renderer is
 * `file://` — which is why it presents as "cloud mode works in the built app
 * and not in dev".
 */
describe('credentials', () => {
  it('omits them in cloud mode, so the wildcard CORS header stays legal', () => {
    remote.value = true
    baseUrl.value = 'http://localhost:31337/cloud/KEY123'
    useSession()
    expect(createAuthClient.mock.calls[0][0]).toMatchObject({
      fetchOptions: { credentials: 'omit' },
    })
  })

  it.each([
    ['local Electron', 'http://localhost:31337'],
    ['the web app, same-origin', ''],
  ])('includes them for %s, whose session IS a cookie on that origin', (_label, base) => {
    remote.value = false
    baseUrl.value = base
    useSession()
    expect(createAuthClient.mock.calls[0][0]).toMatchObject({
      fetchOptions: { credentials: 'include' },
    })
  })
})

describe('base URL resolution', () => {
  it('appends the auth path to the cloud proxy prefix', () => {
    baseUrl.value = 'http://localhost:3000/cloud/KEY123'
    useSession()
    expect(createAuthClient.mock.calls[0][0].baseURL).toBe(
      'http://localhost:3000/cloud/KEY123/api/auth',
    )
  })

  it('appends the auth path to the local API port too', () => {
    baseUrl.value = 'http://localhost:31337'
    useSession()
    expect(createAuthClient.mock.calls[0][0].baseURL).toBe('http://localhost:31337/api/auth')
  })

  it('stays same-origin on the web, which better-auth expresses as no baseURL', () => {
    baseUrl.value = ''
    useSession()
    expect(createAuthClient.mock.calls[0][0].baseURL).toBeUndefined()
  })

  it.each([
    ['local Electron', 'http://localhost:31337'],
    ['a cloud workspace', 'http://localhost:31337/cloud/KEY123'],
    ['a deep proxy prefix', 'http://localhost:31337/cloud/KEY123/nested'],
  ])('hands better-auth a URL it will not rewrite, for %s', (_label, base) => {
    baseUrl.value = base
    useSession()
    const passed = createAuthClient.mock.calls[0][0].baseURL ?? ''

    // Both halves matter. Ending in the auth path is what makes the request
    // land; keeping the whole original base is what keeps a cloud session on the
    // proxy instead of the local API.
    expect(passed.endsWith('/api/auth')).toBe(true)
    expect(passed.startsWith(base)).toBe(true)
  })
})

describe('forwarding', () => {
  it('exposes nested client namespaces through the proxy', () => {
    baseUrl.value = 'http://localhost:3000'
    // users-tab and friends call authClient.admin.* / authClient.changePassword
    // directly; deferring construction must not change that shape.
    expect(typeof authClient.admin.listUsers).toBe('function')
    expect(typeof authClient.changePassword).toBe('function')
  })

  it('forwards calls to the built client', () => {
    baseUrl.value = 'http://localhost:3000'
    const result = useSession()
    expect(result).toEqual({ data: null, isPending: false })
  })
})
