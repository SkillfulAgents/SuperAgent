import { describe, it, expect } from 'vitest'
import {
  getRequiredPermissionLevel,
  resolveTargetApp,
  READ_ONLY_METHODS,
  TIMED_GRANT_DURATION_MS,
} from './types'

describe('getRequiredPermissionLevel', () => {
  it('returns list_apps_windows for all read-only methods', () => {
    for (const method of READ_ONLY_METHODS) {
      expect(getRequiredPermissionLevel(method)).toBe('list_apps_windows')
    }
  })

  it('returns use_application for action methods', () => {
    const actionMethods = [
      'click', 'type', 'fill', 'key', 'scroll', 'select', 'hover',
      'launch', 'quit', 'grab', 'ungrab', 'menuClick', 'dialog',
      'screenshot', 'snapshot', 'find', 'read',
    ]
    for (const method of actionMethods) {
      expect(getRequiredPermissionLevel(method)).toBe('use_application')
    }
  })

  it('returns use_application for unknown methods', () => {
    expect(getRequiredPermissionLevel('unknown_method')).toBe('use_application')
    expect(getRequiredPermissionLevel('')).toBe('use_application')
  })
})

describe('resolveTargetApp', () => {
  it('returns params.app when present', () => {
    expect(resolveTargetApp('click', { app: 'Calculator' })).toBe('Calculator')
  })

  it('returns params.name when present (for launch)', () => {
    expect(resolveTargetApp('launch', { name: 'Calculator' })).toBe('Calculator')
  })

  it('params.app takes precedence over params.name', () => {
    expect(resolveTargetApp('launch', { app: 'Safari', name: 'Calculator' })).toBe('Safari')
  })

  it('returns grabbedApp for non-grab methods without app/name', () => {
    expect(resolveTargetApp('click', { ref: '@b1' }, 'Calculator')).toBe('Calculator')
    expect(resolveTargetApp('type', { text: 'hello' }, 'Safari')).toBe('Safari')
    expect(resolveTargetApp('snapshot', {}, 'Finder')).toBe('Finder')
  })

  it('returns undefined for non-grab methods without app/name and no grabbedApp', () => {
    expect(resolveTargetApp('click', { ref: '@b1' })).toBeUndefined()
    expect(resolveTargetApp('type', { text: 'hello' })).toBeUndefined()
  })

  // --- grab-specific behavior ---

  it('grab: returns params.app when present', () => {
    expect(resolveTargetApp('grab', { app: 'Calculator' })).toBe('Calculator')
  })

  it('grab: returns undefined when only ref is provided (no app)', () => {
    expect(resolveTargetApp('grab', { ref: 'AXWindow "Doc"' })).toBeUndefined()
  })

  it('grab: returns undefined when no params', () => {
    expect(resolveTargetApp('grab', {})).toBeUndefined()
  })

  it('grab: does NOT fall back to grabbedApp', () => {
    expect(resolveTargetApp('grab', {}, 'Calculator')).toBeUndefined()
  })

  it('grab: params.name is checked before grab-specific logic', () => {
    // params.name check happens before the grab-specific block
    expect(resolveTargetApp('grab', { name: 'Calculator' })).toBe('Calculator')
  })

  // --- non-string params ---

  it('ignores non-string params.app', () => {
    expect(resolveTargetApp('click', { app: 123 }, 'Fallback')).toBe('Fallback')
    expect(resolveTargetApp('click', { app: null }, 'Fallback')).toBe('Fallback')
    expect(resolveTargetApp('click', { app: undefined }, 'Fallback')).toBe('Fallback')
    expect(resolveTargetApp('click', { app: true }, 'Fallback')).toBe('Fallback')
  })

  it('ignores non-string params.name', () => {
    expect(resolveTargetApp('launch', { name: 42 }, 'Fallback')).toBe('Fallback')
  })

  // --- empty strings ---

  it('empty string app is falsy so falls through', () => {
    // '' is falsy, so `params.app &&` short-circuits
    expect(resolveTargetApp('click', { app: '' }, 'Fallback')).toBe('Fallback')
  })
})

describe('constants', () => {
  it('READ_ONLY_METHODS contains expected methods', () => {
    expect(READ_ONLY_METHODS).toContain('apps')
    expect(READ_ONLY_METHODS).toContain('windows')
    expect(READ_ONLY_METHODS).toContain('status')
    expect(READ_ONLY_METHODS).toContain('displays')
    expect(READ_ONLY_METHODS).toContain('permissions')
    expect(READ_ONLY_METHODS.size).toBe(5)
  })

  it('TIMED_GRANT_DURATION_MS is 15 minutes', () => {
    expect(TIMED_GRANT_DURATION_MS).toBe(15 * 60 * 1000)
  })
})
