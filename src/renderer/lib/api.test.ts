// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// api.ts imports getApiBaseUrl at module load; stub it so the import is inert.
vi.mock('./env', () => ({ getApiBaseUrl: () => '' }))

// apiFetch dynamically import()s ./auth-client on a 401; mock it so signOut is an
// observable spy and the real better-auth client never loads.
const signOutMock = vi.fn().mockResolvedValue(undefined)
vi.mock('./auth-client', () => ({ signOut: signOutMock }))

import {
  apiFetch,
  apiJson,
  HttpError,
  stashRedirectTarget,
  peekRedirectStash,
  consumeRedirectStash,
  clearRedirectStash,
  markDeliberateSignOut,
  clearDeliberateSignOut,
} from './api'

const KEY = 'superagent.redirect'

describe('redirect stash (post-login restore)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    // `define` installs __AUTH_MODE__ as a real runtime global, so stubGlobal can
    // flip it per case (same mechanism as history.test.ts's __WEB__).
    vi.stubGlobal('__AUTH_MODE__', true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  describe('stashRedirectTarget (P2: cold deep-link survives OAuth)', () => {
    it('stashes a safe internal deep link so peek returns it', () => {
      stashRedirectTarget('/agents/foo/sessions/abc')
      expect(peekRedirectStash()).toBe('/agents/foo/sessions/abc')
    })

    it('is a no-op outside auth mode', () => {
      vi.stubGlobal('__AUTH_MODE__', false)
      stashRedirectTarget('/agents/foo')
      expect(sessionStorage.getItem(KEY)).toBeNull()
      expect(peekRedirectStash()).toBe('/')
    })

    it('skips the default "/" path (no point stashing the fallback)', () => {
      stashRedirectTarget('/')
      expect(sessionStorage.getItem(KEY)).toBeNull()
    })

    it('rejects unsafe paths (open-redirect guard)', () => {
      stashRedirectTarget('//evil.com') // protocol-relative
      stashRedirectTarget('https://evil.com') // absolute URL
      stashRedirectTarget('agents/foo') // no leading slash
      stashRedirectTarget('/\\evil.com') // backslash UNC
      stashRedirectTarget('/%2fevil.com') // encoded slash right after the leading /
      stashRedirectTarget('/%5cevil.com') // encoded backslash right after the leading /
      expect(sessionStorage.getItem(KEY)).toBeNull()
    })

    it('still accepts a deeper encoded separator (only a LEADING one is dangerous)', () => {
      stashRedirectTarget('/settings/general?from=%2Fagents%2Ffoo')
      expect(peekRedirectStash()).toBe('/settings/general?from=%2Fagents%2Ffoo')
    })

    it('overwrites an existing stash so the newest deep-link intent wins', () => {
      sessionStorage.setItem(KEY, '/agents/first/sessions/abc')
      stashRedirectTarget('/agents/second')
      expect(peekRedirectStash()).toBe('/agents/second')
    })
  })

  describe('clearRedirectStash (sign-out)', () => {
    it('drops the stash so it cannot leak into the next session', () => {
      stashRedirectTarget('/agents/foo')
      clearRedirectStash()
      expect(sessionStorage.getItem(KEY)).toBeNull()
      expect(peekRedirectStash()).toBe('/')
    })
  })

  describe('peek vs consume semantics', () => {
    it('peek leaves the stash in place; consume clears it', () => {
      stashRedirectTarget('/agents/foo')
      expect(peekRedirectStash()).toBe('/agents/foo')
      expect(peekRedirectStash()).toBe('/agents/foo') // peek does not clear
      expect(consumeRedirectStash()).toBe('/agents/foo')
      expect(peekRedirectStash()).toBe('/') // now cleared
    })
  })
})

describe('apiJson (loader fetch: status-preserving throw)', () => {
  // afterEach restores fetch so a thrown-error case can't leak the stub into the
  // next test (mirrors the vi.unstubAllGlobals() discipline of the stash suite).
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the parsed JSON body on a 2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ a: 1 }) })))
    await expect(apiJson('/x')).resolves.toEqual({ a: 1 })
  })

  // 403/404 are the access-control statuses the agentLayoutRoute.loader maps to
  // notFound(); 500 is the rethrow-to-errorComponent case. apiJson must surface
  // the EXACT status on the error object so the loader can branch on it.
  it.each([403, 404, 500])('throws an HttpError carrying status %i on a non-2xx response', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status })))
    await expect(apiJson('/x')).rejects.toSatisfy(
      (err: unknown) => err instanceof HttpError && err.status === status && err.name === 'HttpError',
    )
  })
})

describe('apiFetch 401 auto-stash (warm, router-mounted)', () => {
  // The 401 branch is the WARM stash trigger: while the router IS mounted, an
  // expired-session API call stashes the CURRENT window.location and signs out,
  // so an in-place re-sign-in restores the destination. Separate path from the
  // cold stashRedirectTarget above (its own /api/auth/ loop-guard + here!=='/').
  beforeEach(() => {
    sessionStorage.clear()
    signOutMock.mockClear()
    vi.stubGlobal('__AUTH_MODE__', true)
    // Default 401 so apiFetch enters the auto-stash branch unless a case overrides.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }))
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  it('(1) stashes the warm location and signs out on a 401', async () => {
    window.history.replaceState(null, '', '/agents/foo')
    await apiFetch('/api/agents/foo')
    expect(sessionStorage.getItem(KEY)).toBe('/agents/foo')
    expect(signOutMock).toHaveBeenCalledTimes(1)
  })

  it('(2) does NOT stash when the current location is the default "/"', async () => {
    window.history.replaceState(null, '', '/')
    await apiFetch('/api/agents/foo')
    expect(sessionStorage.getItem(KEY)).toBeNull()
    // still signs out (the here!=='/' guard only gates the stash, not the sign-out)
    expect(signOutMock).toHaveBeenCalledTimes(1)
  })

  it('(3) skips the branch entirely for /api/auth/* (sign-out loop guard)', async () => {
    window.history.replaceState(null, '', '/agents/foo')
    await apiFetch('/api/auth/session')
    expect(sessionStorage.getItem(KEY)).toBeNull()
    expect(signOutMock).not.toHaveBeenCalled()
  })

  it('(4) is a no-op outside auth mode', async () => {
    vi.stubGlobal('__AUTH_MODE__', false)
    window.history.replaceState(null, '', '/agents/foo')
    await apiFetch('/api/agents/foo')
    expect(sessionStorage.getItem(KEY)).toBeNull()
    expect(signOutMock).not.toHaveBeenCalled()
  })

  it('does not stash or sign out on a non-401 (e.g. 403 forbidden)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 403 }))
    window.history.replaceState(null, '', '/agents/foo')
    await apiFetch('/api/agents/foo')
    expect(sessionStorage.getItem(KEY)).toBeNull()
    expect(signOutMock).not.toHaveBeenCalled()
  })

  it('is latched off during a deliberate sign-out and re-arms after sign-in', async () => {
    window.history.replaceState(null, '', '/agents/foo')

    // Trailing background 401s after the user clicked Sign out must not
    // re-stash the signed-out user's URL (shared-tab leak) nor re-fire signOut.
    markDeliberateSignOut()
    await apiFetch('/api/agents/foo')
    expect(sessionStorage.getItem(KEY)).toBeNull()
    expect(signOutMock).not.toHaveBeenCalled()

    // Once a session authenticates again the handler is re-armed.
    clearDeliberateSignOut()
    await apiFetch('/api/agents/foo')
    expect(sessionStorage.getItem(KEY)).toBe('/agents/foo')
    expect(signOutMock).toHaveBeenCalledTimes(1)
  })
})
