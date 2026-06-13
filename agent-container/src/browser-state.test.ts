import { describe, it, expect, beforeEach } from 'vitest'
import {
  getBrowserState,
  setBrowserState,
  resetBrowserState,
  validateBrowserSession,
  releaseBrowserLock,
  renameBrowserSession,
  transferBrowserLock,
} from './browser-state'

describe('browser-state', () => {
  beforeEach(() => {
    resetBrowserState()
  })

  describe('validateBrowserSession', () => {
    it('allows access when browser is not active', () => {
      expect(validateBrowserSession('session-1')).toBeNull()
    })

    it('allows access when the requesting session owns the browser', () => {
      setBrowserState({ active: true, sessionId: 'session-1', cdpUrl: null })
      expect(validateBrowserSession('session-1')).toBeNull()
    })

    it('blocks access when a different session owns the browser', () => {
      setBrowserState({ active: true, sessionId: 'session-1', cdpUrl: null })
      const error = validateBrowserSession('session-2')
      expect(error).toBe('Browser is owned by session session-1')
    })
  })

  describe('releaseBrowserLock', () => {
    it('releases the lock when the owning session calls it', () => {
      setBrowserState({ active: true, sessionId: 'session-1', cdpUrl: 'ws://localhost:9222' })
      const released = releaseBrowserLock('session-1')
      expect(released).toBe(true)
      expect(getBrowserState()).toEqual({ active: false, sessionId: null, cdpUrl: null })
    })

    it('does not release the lock when a non-owning session calls it', () => {
      setBrowserState({ active: true, sessionId: 'session-1', cdpUrl: 'ws://localhost:9222' })
      const released = releaseBrowserLock('session-2')
      expect(released).toBe(false)
      expect(getBrowserState().active).toBe(true)
      expect(getBrowserState().sessionId).toBe('session-1')
    })

    it('returns false when browser is not active', () => {
      const released = releaseBrowserLock('session-1')
      expect(released).toBe(false)
    })

    it('allows a new session to acquire the browser after release', () => {
      setBrowserState({ active: true, sessionId: 'session-1', cdpUrl: null })

      // session-2 is blocked
      expect(validateBrowserSession('session-2')).not.toBeNull()

      // session-1 releases
      releaseBrowserLock('session-1')

      // session-2 can now acquire
      expect(validateBrowserSession('session-2')).toBeNull()
    })
  })

  describe('renameBrowserSession', () => {
    it('re-keys the lock when the old id owns it (query restart mid-browse)', () => {
      setBrowserState({ active: true, sessionId: 'old-id', cdpUrl: 'ws://localhost:9222' })
      expect(renameBrowserSession('old-id', 'new-id')).toBe(true)
      expect(getBrowserState().sessionId).toBe('new-id')
      expect(getBrowserState().cdpUrl).toBe('ws://localhost:9222')
      // requests under the new id now pass; old id no longer matches
      expect(validateBrowserSession('new-id')).toBeNull()
      expect(validateBrowserSession('old-id')).not.toBeNull()
    })

    it('does nothing when the old id does not own the lock', () => {
      setBrowserState({ active: true, sessionId: 'other-session', cdpUrl: null })
      expect(renameBrowserSession('old-id', 'new-id')).toBe(false)
      expect(getBrowserState().sessionId).toBe('other-session')
    })

    it('does nothing when the browser is inactive', () => {
      expect(renameBrowserSession('old-id', 'new-id')).toBe(false)
      expect(getBrowserState().active).toBe(false)
    })
  })

  describe('transferBrowserLock', () => {
    it('reassigns ownership while preserving the live connection', () => {
      setBrowserState({ active: true, sessionId: 'dead-session', cdpUrl: 'ws://localhost:9222' })
      transferBrowserLock('live-session')
      expect(getBrowserState()).toEqual({ active: true, sessionId: 'live-session', cdpUrl: 'ws://localhost:9222' })
      expect(validateBrowserSession('live-session')).toBeNull()
    })

    it('does nothing when the browser is inactive', () => {
      transferBrowserLock('live-session')
      expect(getBrowserState().active).toBe(false)
      expect(getBrowserState().sessionId).toBeNull()
    })
  })

  describe('stale lock scenario (SUP-167)', () => {
    it('a finished cron session should not block the next cron session', () => {
      // Cron run #1 opens the browser
      setBrowserState({ active: true, sessionId: 'cron-session-1', cdpUrl: 'ws://localhost:9222' })

      // Cron run #1 finishes and releases
      releaseBrowserLock('cron-session-1')

      // Cron run #2 should be able to use the browser
      expect(validateBrowserSession('cron-session-2')).toBeNull()
    })

    it('without release, a finished cron session blocks the next one', () => {
      // Cron run #1 opens the browser
      setBrowserState({ active: true, sessionId: 'cron-session-1', cdpUrl: 'ws://localhost:9222' })

      // Cron run #1 finishes but does NOT release (the bug)
      // Cron run #2 tries to use the browser — blocked
      expect(validateBrowserSession('cron-session-2')).toBe(
        'Browser is owned by session cron-session-1'
      )
    })
  })
})
