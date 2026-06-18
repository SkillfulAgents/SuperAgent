// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// api.ts imports getApiBaseUrl at module load; stub it so the import is inert.
vi.mock('./env', () => ({ getApiBaseUrl: () => '' }))

import { stashRedirectTarget, peekRedirectStash, consumeRedirectStash, clearRedirectStash } from './api'

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
