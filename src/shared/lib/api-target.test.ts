import { describe, expect, it } from 'vitest'

import { coerceApiTarget, resolveApiTarget } from './api-target'

describe('coerceApiTarget', () => {
  it('accepts a stored cloud choice', () => {
    expect(coerceApiTarget('cloud')).toBe('cloud')
  })

  it('reads anything unrecognized as local', () => {
    // A hand-edited settings file or a future version's target must not route
    // work off this machine.
    for (const value of ['production', '', null, undefined, 7, {}, ['cloud']]) {
      expect(coerceApiTarget(value)).toBe('local')
    }
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
