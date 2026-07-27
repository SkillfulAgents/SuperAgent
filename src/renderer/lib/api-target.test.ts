import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _resetApiTargetForTest,
  getActiveTarget,
  getTargetFallbackReason,
  readPreferredTarget,
  resolveApiTarget,
  setActiveTarget,
  targetIsRemote,
  writePreferredTarget,
} from './api-target'

/** A localStorage stand-in; `failing` models private mode / a locked-down host. */
function stubStorage(initial: Record<string, string> = {}, failing = false) {
  const store = new Map(Object.entries(initial))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => {
        if (failing) throw new Error('storage unavailable')
        return store.get(key) ?? null
      },
      setItem: (key: string, value: string) => {
        if (failing) throw new Error('storage unavailable')
        store.set(key, value)
      },
    },
  })
  return store
}

beforeEach(() => {
  _resetApiTargetForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  _resetApiTargetForTest()
})

describe('preferred target', () => {
  it('defaults to local when nothing was ever chosen', () => {
    stubStorage()
    expect(readPreferredTarget()).toBe('local')
  })

  it('remembers a cloud choice', () => {
    stubStorage({ 'superagent.apiTarget': 'cloud' })
    expect(readPreferredTarget()).toBe('cloud')
  })

  it('treats an unrecognized stored value as local', () => {
    stubStorage({ 'superagent.apiTarget': 'production' })
    expect(readPreferredTarget()).toBe('local')
  })

  it('reads local when storage is unavailable rather than throwing at boot', () => {
    stubStorage({}, true)
    expect(readPreferredTarget()).toBe('local')
  })

  it('persists a choice for the next boot', () => {
    const store = stubStorage()
    writePreferredTarget('cloud')
    expect(store.get('superagent.apiTarget')).toBe('cloud')
  })

  it('survives storage that refuses to write', () => {
    stubStorage({}, true)
    expect(() => writePreferredTarget('cloud')).not.toThrow()
  })
})

describe('resolveApiTarget', () => {
  it('honours a cloud preference when a workspace is reachable', () => {
    expect(resolveApiTarget('cloud', 'http://localhost:3000/cloud/KEY')).toEqual({
      target: 'cloud',
      fallback: null,
    })
  })

  it('falls back to local when the workspace is gone', () => {
    // Left in cloud mode, then disconnected the platform account: a working
    // local app and one notice, not a wall of failures.
    expect(resolveApiTarget('cloud', null)).toEqual({
      target: 'local',
      fallback: 'no-workspace',
    })
  })

  it('stays local without inventing a reason', () => {
    expect(resolveApiTarget('local', null)).toEqual({ target: 'local', fallback: null })
  })

  it('ignores a reachable workspace when local was chosen', () => {
    expect(resolveApiTarget('local', 'http://localhost:3000/cloud/KEY')).toEqual({
      target: 'local',
      fallback: null,
    })
  })
})

describe('active target', () => {
  it('throws rather than guessing before boot has settled it', () => {
    // 'local' would be a plausible wrong answer, and the way that fails is
    // cloud traffic quietly hitting the laptop.
    expect(() => getActiveTarget()).toThrow(/before initApiBaseUrl/)
    expect(() => targetIsRemote()).toThrow(/before initApiBaseUrl/)
  })

  it('reports the settled target', () => {
    setActiveTarget('cloud', null)
    expect(getActiveTarget()).toBe('cloud')
    expect(targetIsRemote()).toBe(true)
  })

  it('reports local as not remote', () => {
    setActiveTarget('local', null)
    expect(targetIsRemote()).toBe(false)
  })

  it('carries the reason a cloud preference was denied', () => {
    setActiveTarget('local', 'no-workspace')
    expect(getTargetFallbackReason()).toBe('no-workspace')
  })

  it('has no fallback reason before anything is denied', () => {
    expect(getTargetFallbackReason()).toBeNull()
  })
})
