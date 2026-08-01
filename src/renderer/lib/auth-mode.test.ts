import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetApiTargetForTest, setActiveTarget } from './api-target'
import { hasInteractiveLogin, isAuthMode } from './auth-mode'

/**
 * Auth mode used to be a build-time constant, false in every Electron build.
 * A cloud workspace is an auth-mode deployment, so driving one has to turn it
 * on at runtime — otherwise the UI reports no user, no admin, and grants every
 * per-agent capability, and the user meets their real permissions as 403s.
 */

beforeEach(() => {
  _resetApiTargetForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  _resetApiTargetForTest()
})

describe('isAuthMode', () => {
  it('is off for the local API in a desktop build', () => {
    vi.stubGlobal('__AUTH_MODE__', false)
    setActiveTarget('local', null)
    expect(isAuthMode()).toBe(false)
  })

  it('is on when the build says so, as before', () => {
    vi.stubGlobal('__AUTH_MODE__', true)
    setActiveTarget('local', null)
    expect(isAuthMode()).toBe(true)
  })

  it('is on for a cloud workspace even in a build compiled with auth off', () => {
    // The whole point of the phase: every Electron build compiles this false.
    vi.stubGlobal('__AUTH_MODE__', false)
    setActiveTarget('cloud', null)
    expect(isAuthMode()).toBe(true)
  })

  it('throws rather than guessing before boot settles the target', () => {
    vi.stubGlobal('__AUTH_MODE__', false)
    // Hooks are called conditionally on this value. A module that read it early
    // would take a branch that later renders contradict — a hooks-order crash
    // reproducing only in cloud mode. Failing loudly is the cheap version.
    expect(() => isAuthMode()).toThrow(/before initApiBaseUrl/)
  })
})

describe('hasInteractiveLogin', () => {
  it('is true for a web auth-mode deployment, which has a login form', () => {
    vi.stubGlobal('__AUTH_MODE__', true)
    setActiveTarget('local', null)
    expect(hasInteractiveLogin()).toBe(true)
  })

  it('is false for a cloud workspace, whose credential is held by main', () => {
    vi.stubGlobal('__AUTH_MODE__', false)
    setActiveTarget('cloud', null)
    // Auth is on, but there is nothing for the user to type.
    expect(isAuthMode()).toBe(true)
    expect(hasInteractiveLogin()).toBe(false)
  })

  it('stays false for a cloud workspace even in an auth-mode build', () => {
    // A web deployment build that somehow drives a cloud target must still not
    // offer a password form for a bearer-token session.
    vi.stubGlobal('__AUTH_MODE__', true)
    setActiveTarget('cloud', null)
    expect(hasInteractiveLogin()).toBe(false)
  })

  it('is false when auth is off entirely', () => {
    vi.stubGlobal('__AUTH_MODE__', false)
    setActiveTarget('local', null)
    expect(hasInteractiveLogin()).toBe(false)
  })
})

describe('freezing', () => {
  it('refuses to change the target once settled', () => {
    setActiveTarget('local', null)
    // Reload-on-switch is not a convention here — it is what keeps the
    // conditional hooks in user-context sound.
    expect(() => setActiveTarget('cloud', null)).toThrow(/already settled/)
  })

  it('keeps the answer stable across reads', () => {
    vi.stubGlobal('__AUTH_MODE__', false)
    setActiveTarget('cloud', null)
    expect([isAuthMode(), isAuthMode(), isAuthMode()]).toEqual([true, true, true])
  })
})
