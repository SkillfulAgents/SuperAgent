import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ComputerUsePermissionManager } from './permission-manager'
import { TIMED_GRANT_DURATION_MS } from './types'

const mockGetSettings = vi.fn()
const mockUpdateSettings = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
}))

describe('ComputerUsePermissionManager', () => {
  let pm: ComputerUsePermissionManager

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSettings.mockReturnValue({})
    mockUpdateSettings.mockReturnValue(undefined)
    pm = new ComputerUsePermissionManager()
  })

  // ─── checkPermission ──────────────────────────────────────────────

  describe('checkPermission', () => {
    it('returns prompt_needed for unknown agent', () => {
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('returns prompt_needed for agent with no matching grants', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Safari')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('returns granted for matching once grant', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('returns granted for matching timed grant', () => {
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('returns granted for matching always grant', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('returns prompt_needed for expired timed grant', () => {
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      // Fast-forward past expiry
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TIMED_GRANT_DURATION_MS + 1)
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('returns granted for timed grant at exact boundary', () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      // Set time to exactly the expiry (should still be expired: expiresAt < now)
      vi.spyOn(Date, 'now').mockReturnValue(now + TIMED_GRANT_DURATION_MS)
      // At exactly expiresAt, the check is `expiresAt < now`, so equal means NOT expired
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('returns prompt_needed one ms after timed grant expires', () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      vi.spyOn(Date, 'now').mockReturnValue(now + TIMED_GRANT_DURATION_MS + 1)
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('lazy-loads settings on first checkPermission call', () => {
      mockGetSettings.mockReturnValue({
        computerUse: {
          agentPermissions: {
            'agent-1': {
              grants: [{ level: 'use_application', appName: 'Calculator', grantType: 'always' }],
            },
          },
        },
      })
      // First call triggers load
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
      expect(mockGetSettings).toHaveBeenCalledTimes(1)
      // Second call should NOT reload
      pm.checkPermission('agent-1', 'use_application', 'Calculator')
      expect(mockGetSettings).toHaveBeenCalledTimes(1)
    })
  })

  // ─── Grant matching: appName semantics ────────────────────────────

  describe('appName matching', () => {
    it('use_application: requires exact appName match', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
      expect(pm.checkPermission('agent-1', 'use_application', 'Safari')).toBe('prompt_needed')
    })

    it('use_application: undefined appName only matches undefined grant', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', undefined)
      expect(pm.checkPermission('agent-1', 'use_application', undefined)).toBe('granted')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('use_application: grant with appName does NOT match undefined check', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', undefined)).toBe('prompt_needed')
    })

    it('list_apps_windows: ignores appName (level-only matching)', () => {
      pm.grantPermission('agent-1', 'list_apps_windows', 'once')
      expect(pm.checkPermission('agent-1', 'list_apps_windows')).toBe('granted')
      expect(pm.checkPermission('agent-1', 'list_apps_windows', 'Calculator')).toBe('granted')
    })

    it('use_host_shell: ignores appName (level-only matching)', () => {
      pm.grantPermission('agent-1', 'use_host_shell', 'once')
      expect(pm.checkPermission('agent-1', 'use_host_shell')).toBe('granted')
      expect(pm.checkPermission('agent-1', 'use_host_shell', 'Terminal')).toBe('granted')
    })

    it('different levels never match each other', () => {
      pm.grantPermission('agent-1', 'list_apps_windows', 'always')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
      expect(pm.checkPermission('agent-1', 'use_host_shell')).toBe('prompt_needed')
    })
  })

  // ─── Multi-agent isolation ────────────────────────────────────────

  describe('agent isolation', () => {
    it('grants for one agent do not affect another', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
      expect(pm.checkPermission('agent-2', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('revoking one agent does not affect others', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.grantPermission('agent-2', 'use_application', 'always', 'Calculator')
      pm.revokeAllForAgent('agent-1')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
      expect(pm.checkPermission('agent-2', 'use_application', 'Calculator')).toBe('granted')
    })
  })

  // ─── grantPermission ─────────────────────────────────────────────

  describe('grantPermission', () => {
    it('once grants can stack (multiple for same level/app)', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      // Both exist
      const grants = pm.getGrantsForAgent('agent-1')
      expect(grants.filter(g => g.grantType === 'once')).toHaveLength(2)
    })

    it('timed grant replaces previous timed grant for same level/app', () => {
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      const grants = pm.getGrantsForAgent('agent-1')
      expect(grants.filter(g => g.grantType === 'timed')).toHaveLength(1)
    })

    it('always grant replaces previous always grant for same level/app', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      const grants = pm.getGrantsForAgent('agent-1')
      expect(grants.filter(g => g.grantType === 'always')).toHaveLength(1)
    })

    it('timed grant replaces existing matching grants (including once)', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      const grants = pm.getGrantsForAgent('agent-1')
      // removeMatchingGrants removes all matching grants regardless of type
      expect(grants).toHaveLength(1)
      expect(grants[0].grantType).toBe('timed')
    })

    it('always grant persists to settings', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
      const call = mockUpdateSettings.mock.calls[0][0]
      expect(call.computerUse.agentPermissions['agent-1'].grants).toEqual([
        { level: 'use_application', appName: 'Calculator', grantType: 'always' },
      ])
    })

    it('once grant does NOT persist to settings', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('timed grant does NOT persist to settings', () => {
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('timed grant has expiresAt set', () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      const grants = pm.getGrantsForAgent('agent-1')
      expect(grants[0].expiresAt).toBe(now + TIMED_GRANT_DURATION_MS)
    })

    it('once grant has no expiresAt', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      const grants = pm.getGrantsForAgent('agent-1')
      expect(grants[0].expiresAt).toBeUndefined()
    })

    it('always grant has no expiresAt', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      const grants = pm.getGrantsForAgent('agent-1')
      expect(grants[0].expiresAt).toBeUndefined()
    })

    it('grants for different apps coexist', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'always', 'Safari')
      const grants = pm.getGrantsForAgent('agent-1')
      expect(grants).toHaveLength(2)
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
      expect(pm.checkPermission('agent-1', 'use_application', 'Safari')).toBe('granted')
    })

    it('grants for different levels coexist', () => {
      pm.grantPermission('agent-1', 'list_apps_windows', 'always')
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.grantPermission('agent-1', 'use_host_shell', 'always')
      const grants = pm.getGrantsForAgent('agent-1')
      expect(grants).toHaveLength(3)
    })

    it('grant without appName stores no appName field', () => {
      pm.grantPermission('agent-1', 'list_apps_windows', 'once')
      const grants = pm.getGrantsForAgent('agent-1')
      expect('appName' in grants[0]).toBe(false)
    })
  })

  // ─── consumeOnceGrant ─────────────────────────────────────────────

  describe('consumeOnceGrant', () => {
    it('removes the first matching once grant', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('consumes only one when multiple once grants exist', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      // One should remain
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('does NOT consume timed grants', () => {
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('does NOT consume always grants', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('is a no-op for unknown agent', () => {
      // Should not throw
      pm.consumeOnceGrant('unknown-agent', 'use_application', 'Calculator')
    })

    it('is a no-op when no matching grant exists', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Safari')
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      // Safari grant should still be there
      expect(pm.checkPermission('agent-1', 'use_application', 'Safari')).toBe('granted')
    })

    it('matches appName strictly (undefined vs string)', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', undefined)
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      // undefined grant should still be there (didn't match 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', undefined)).toBe('granted')
    })
  })

  // ─── revokeAllForAgent ────────────────────────────────────────────

  describe('revokeAllForAgent', () => {
    it('removes all grants for the agent', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Safari')
      pm.grantPermission('agent-1', 'use_application', 'once', 'Finder')
      pm.revokeAllForAgent('agent-1')
      expect(pm.getGrantsForAgent('agent-1')).toHaveLength(0)
    })

    it('clears grabbed app state', () => {
      pm.setGrabbedApp('agent-1', 'Calculator')
      pm.revokeAllForAgent('agent-1')
      expect(pm.getGrabbedApp('agent-1')).toBeUndefined()
    })

    it('persists to settings', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      mockUpdateSettings.mockClear()
      pm.revokeAllForAgent('agent-1')
      expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    })

    it('is safe to call for unknown agent', () => {
      pm.revokeAllForAgent('nonexistent')
      expect(pm.getGrantsForAgent('nonexistent')).toHaveLength(0)
    })
  })

  // ─── revokeGrant ──────────────────────────────────────────────────

  describe('revokeGrant', () => {
    it('removes matching grants', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.revokeGrant('agent-1', 'use_application', 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('does not remove grants for different apps', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'always', 'Safari')
      pm.revokeGrant('agent-1', 'use_application', 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
      expect(pm.checkPermission('agent-1', 'use_application', 'Safari')).toBe('granted')
    })

    it('does not remove grants for different levels', () => {
      pm.grantPermission('agent-1', 'list_apps_windows', 'always')
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.revokeGrant('agent-1', 'use_application', 'Calculator')
      expect(pm.checkPermission('agent-1', 'list_apps_windows')).toBe('granted')
    })

    it('persists to settings', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      mockUpdateSettings.mockClear()
      pm.revokeGrant('agent-1', 'use_application', 'Calculator')
      expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    })
  })

  // ─── getGrantsForAgent ────────────────────────────────────────────

  describe('getGrantsForAgent', () => {
    it('returns empty array for unknown agent', () => {
      expect(pm.getGrantsForAgent('agent-1')).toEqual([])
    })

    it('filters out expired timed grants', () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'always', 'Safari')
      // Fast-forward past expiry
      vi.spyOn(Date, 'now').mockReturnValue(now + TIMED_GRANT_DURATION_MS + 1)
      const grants = pm.getGrantsForAgent('agent-1')
      expect(grants).toHaveLength(1)
      expect(grants[0].appName).toBe('Safari')
    })

    it('includes non-expired timed grants', () => {
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      const grants = pm.getGrantsForAgent('agent-1')
      expect(grants).toHaveLength(1)
    })

    it('always includes once and always grants', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'always', 'Safari')
      const grants = pm.getGrantsForAgent('agent-1')
      expect(grants).toHaveLength(2)
    })
  })

  // ─── Grabbed app tracking ─────────────────────────────────────────

  describe('grabbed app tracking', () => {
    it('setGrabbedApp / getGrabbedApp round-trip', () => {
      pm.setGrabbedApp('agent-1', 'Calculator')
      expect(pm.getGrabbedApp('agent-1')).toBe('Calculator')
    })

    it('getGrabbedApp returns undefined for unknown agent', () => {
      expect(pm.getGrabbedApp('agent-1')).toBeUndefined()
    })

    it('clearGrabbedApp removes the entry', () => {
      pm.setGrabbedApp('agent-1', 'Calculator')
      pm.clearGrabbedApp('agent-1')
      expect(pm.getGrabbedApp('agent-1')).toBeUndefined()
    })

    it('setGrabbedApp overwrites previous value', () => {
      pm.setGrabbedApp('agent-1', 'Calculator')
      pm.setGrabbedApp('agent-1', 'Safari')
      expect(pm.getGrabbedApp('agent-1')).toBe('Safari')
    })

    it('agents have independent grabbed app state', () => {
      pm.setGrabbedApp('agent-1', 'Calculator')
      pm.setGrabbedApp('agent-2', 'Safari')
      expect(pm.getGrabbedApp('agent-1')).toBe('Calculator')
      expect(pm.getGrabbedApp('agent-2')).toBe('Safari')
    })
  })

  // ─── Settings persistence round-trip ──────────────────────────────

  describe('settings persistence', () => {
    it('loadFromSettings loads always grants from settings', () => {
      mockGetSettings.mockReturnValue({
        computerUse: {
          agentPermissions: {
            'agent-1': {
              grants: [
                { level: 'use_application', appName: 'Calculator', grantType: 'always' },
                { level: 'list_apps_windows', grantType: 'always' },
              ],
            },
          },
        },
      })
      // Trigger lazy load
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
      expect(pm.checkPermission('agent-1', 'list_apps_windows')).toBe('granted')
    })

    it('loadFromSettings handles missing computerUse gracefully', () => {
      mockGetSettings.mockReturnValue({})
      // Should not throw
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('loadFromSettings handles missing agentPermissions gracefully', () => {
      mockGetSettings.mockReturnValue({ computerUse: {} })
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('loadFromSettings handles error gracefully', () => {
      mockGetSettings.mockImplementation(() => { throw new Error('disk error') })
      // Should not throw, should return prompt_needed
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('persistToSettings only saves always grants', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Safari')
      pm.grantPermission('agent-1', 'use_application', 'always', 'Finder')
      // Only 'always' call triggers persist, check the latest call
      const lastCall = mockUpdateSettings.mock.calls[mockUpdateSettings.mock.calls.length - 1][0]
      const saved = lastCall.computerUse.agentPermissions['agent-1'].grants
      expect(saved).toEqual([
        { level: 'use_application', appName: 'Finder', grantType: 'always' },
      ])
    })

    it('persistToSettings removes agent entry when no always grants remain', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.revokeGrant('agent-1', 'use_application', 'Calculator')
      const lastCall = mockUpdateSettings.mock.calls[mockUpdateSettings.mock.calls.length - 1][0]
      expect(lastCall.computerUse.agentPermissions['agent-1']).toBeUndefined()
    })

    it('persistToSettings handles error gracefully', () => {
      mockUpdateSettings.mockImplementation(() => { throw new Error('disk error') })
      // Should not throw
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
    })

    it('loadFromSettings merges with existing in-memory grants', () => {
      mockGetSettings.mockReturnValue({
        computerUse: {
          agentPermissions: {
            'agent-1': {
              grants: [{ level: 'use_application', appName: 'Calculator', grantType: 'always' }],
            },
          },
        },
      })
      // Manually add an in-memory grant BEFORE lazy load triggers
      // We do this by accessing the internal state indirectly: grant first, then load
      // Actually, the lazy load happens on first checkPermission, so if we grant first,
      // the ensureLoaded in grant will trigger load, then the grant is added after
      pm.grantPermission('agent-1', 'use_application', 'once', 'Safari')
      // Now both the loaded 'always' for Calculator and the in-memory 'once' for Safari should exist
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
      expect(pm.checkPermission('agent-1', 'use_application', 'Safari')).toBe('granted')
    })

    it('persists multiple agents correctly', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.grantPermission('agent-2', 'use_host_shell', 'always')
      const lastCall = mockUpdateSettings.mock.calls[mockUpdateSettings.mock.calls.length - 1][0]
      expect(lastCall.computerUse.agentPermissions['agent-1']).toBeDefined()
      expect(lastCall.computerUse.agentPermissions['agent-2']).toBeDefined()
    })
  })

  // ─── Edge cases and stress scenarios ──────────────────────────────

  describe('edge cases', () => {
    it('empty string appName is treated as falsy (no appName field stored)', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', '')
      const grants = pm.getGrantsForAgent('agent-1')
      // Empty string is falsy, so appName should NOT be set
      expect('appName' in grants[0]).toBe(false)
    })

    it('many grants for same agent do not leak or corrupt', () => {
      for (let i = 0; i < 100; i++) {
        pm.grantPermission('agent-1', 'use_application', 'once', `App${i}`)
      }
      expect(pm.getGrantsForAgent('agent-1')).toHaveLength(100)
      // Consume a few
      for (let i = 0; i < 10; i++) {
        pm.consumeOnceGrant('agent-1', 'use_application', `App${i}`)
      }
      expect(pm.getGrantsForAgent('agent-1')).toHaveLength(90)
    })

    it('timed grant replaced by new timed grant resets expiry', () => {
      const t1 = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(t1)
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')

      const t2 = t1 + 10 * 60 * 1000 // 10 minutes later
      vi.spyOn(Date, 'now').mockReturnValue(t2)
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')

      // At t1 + 16 minutes: first would have expired, but second should still be valid
      vi.spyOn(Date, 'now').mockReturnValue(t2 + 14 * 60 * 1000)
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('revokeGrant with undefined appName removes undefined-appName grants', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', undefined)
      pm.revokeGrant('agent-1', 'use_application', undefined)
      expect(pm.checkPermission('agent-1', 'use_application', undefined)).toBe('prompt_needed')
    })

    it('revokeGrant with undefined appName does NOT remove named grants', () => {
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.revokeGrant('agent-1', 'use_application', undefined)
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('once + timed + always for same app: each non-once replaces all prior', () => {
      // Granting timed replaces the once, granting always replaces the timed
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      const grants = pm.getGrantsForAgent('agent-1')
      expect(grants).toHaveLength(1)
      expect(grants[0].grantType).toBe('always')
    })

    it('once grant alongside always for different app is preserved', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.grantPermission('agent-1', 'use_application', 'always', 'Safari')
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      // Safari always should still be there
      expect(pm.checkPermission('agent-1', 'use_application', 'Safari')).toBe('granted')
      expect(pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('case-sensitive appName matching', () => {
      pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      expect(pm.checkPermission('agent-1', 'use_application', 'calculator')).toBe('prompt_needed')
      expect(pm.checkPermission('agent-1', 'use_application', 'CALCULATOR')).toBe('prompt_needed')
    })
  })
})
