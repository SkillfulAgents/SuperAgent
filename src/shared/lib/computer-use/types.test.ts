import { describe, it, expect } from 'vitest'
import { READ_ONLY_COMMANDS } from './commands'
import {
  computerUsePreferences,
  DEFAULT_COMPUTER_USE_PREFERENCES,
  getRequiredPermissionLevel,
  TIMED_GRANT_DURATION_MS,
} from './types'

describe('getRequiredPermissionLevel', () => {
  it('returns list_apps_windows for all read-only commands', () => {
    for (const method of READ_ONLY_COMMANDS) {
      expect(getRequiredPermissionLevel(method)).toBe('list_apps_windows')
    }
  })

  it('returns use_application for commands that read or act in an app', () => {
    const actionMethods = [
      'snapshot', 'find', 'get', 'screenshot', 'click', 'right-click', 'type', 'set-value',
      'select', 'scroll', 'press', 'launch', 'close-app', 'double-click', 'clipboard-get',
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

describe('computerUsePreferences', () => {
  it('shows the cursor and runs headed by default', () => {
    expect(DEFAULT_COMPUTER_USE_PREFERENCES).toEqual({ showCursor: true, inputMode: 'headed' })
    expect(computerUsePreferences(undefined)).toEqual({ showCursor: true, inputMode: 'headed' })
    expect(computerUsePreferences({ agentPermissions: {} })).toEqual({ showCursor: true, inputMode: 'headed' })
  })

  it('keeps what the user chose', () => {
    expect(computerUsePreferences({ showCursor: false, inputMode: 'headless' })).toEqual({ showCursor: false, inputMode: 'headless' })
  })

  it('reads a stored value of the wrong kind (a hand edit) as unset', () => {
    type Stored = Parameters<typeof computerUsePreferences>[0]
    expect(computerUsePreferences({ showCursor: 'false', inputMode: 'foo' } as unknown as Stored)).toEqual({ showCursor: true, inputMode: 'headed' })
    expect(computerUsePreferences({ showCursor: false, inputMode: 'foo' } as unknown as Stored)).toEqual({ showCursor: false, inputMode: 'headed' })
  })
})

describe('constants', () => {
  it('TIMED_GRANT_DURATION_MS is 15 minutes', () => {
    expect(TIMED_GRANT_DURATION_MS).toBe(15 * 60 * 1000)
  })
})
