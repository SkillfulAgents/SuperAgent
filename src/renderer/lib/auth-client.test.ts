// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// This file tests the real module, not the global stub from test/setup.ts.
vi.unmock('@renderer/lib/auth-client')

const { createAuthClient, baseUrl } = vi.hoisted(() => ({
  createAuthClient: vi.fn((_options: { baseURL?: string }) => ({
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
      baseURL: 'http://localhost:3000/cloud/KEY123',
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

describe('base URL resolution', () => {
  it('points at the cloud proxy prefix in cloud mode', () => {
    baseUrl.value = 'http://localhost:3000/cloud/KEY123'
    useSession()
    expect(createAuthClient.mock.calls[0][0].baseURL).toBe('http://localhost:3000/cloud/KEY123')
  })

  it('points at the local API port in local Electron mode', () => {
    baseUrl.value = 'http://localhost:31337'
    useSession()
    expect(createAuthClient.mock.calls[0][0].baseURL).toBe('http://localhost:31337')
  })

  it('stays same-origin on the web, which better-auth expresses as no baseURL', () => {
    baseUrl.value = ''
    useSession()
    expect(createAuthClient.mock.calls[0][0].baseURL).toBeUndefined()
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
