import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentStoreDirectory } from '@shared/lib/agent-actor/store-directory'
import { AgentComputerUse } from './agent-permissions'
import { ComputerUsePermissionManager } from './permission-manager'
import { TIMED_GRANT_DURATION_MS } from './types'

const mockGetSettings = vi.fn()
const mockUpdateSettings = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
  // Persisting uses the serialized fresh-read mutateSettings. Reproduce its
  // observable effect against the seeded mock so the mockUpdateSettings
  // assertions hold, and feed the written settings back into the next read,
  // as the real one does: each agent writes only its own entry, so a second
  // agent's persist must see the first agent's.
  mutateSettings: (mutator: (s: Record<string, unknown>) => void) => {
    const s = structuredClone(mockGetSettings() ?? {})
    mutator(s)
    mockUpdateSettings(s)
    mockGetSettings.mockReturnValue(s)
    return s
  },
}))

/** The actors' stores without the actors: one per slug, created on first use, as the registry would. */
function inMemoryStores(): AgentStoreDirectory<AgentComputerUse> {
  const stores = new Map<string, AgentComputerUse>()
  return {
    get: (slug) => {
      let store = stores.get(slug)
      if (!store) {
        store = new AgentComputerUse(slug)
        stores.set(slug, store)
      }
      return store
    },
    peek: (slug) => stores.get(slug),
    all: () => [...stores.values()],
  }
}

describe('ComputerUsePermissionManager', () => {
  let pm: ComputerUsePermissionManager

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSettings.mockReturnValue({})
    mockUpdateSettings.mockReturnValue(undefined)
    pm = new ComputerUsePermissionManager()
    pm.attachAgents(inMemoryStores())
  })

  // ─── checkPermission ──────────────────────────────────────────────

  describe('checkPermission', () => {
    it('returns prompt_needed for unknown agent', async () => {
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('returns prompt_needed for agent with no matching grants', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Safari')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('returns granted for matching once grant', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('returns granted for matching timed grant', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('returns granted for matching always grant', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('returns prompt_needed for expired timed grant', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      // Fast-forward past expiry
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TIMED_GRANT_DURATION_MS + 1)
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('returns granted for timed grant at exact boundary', async () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      // Set time to exactly the expiry (should still be expired: expiresAt < now)
      vi.spyOn(Date, 'now').mockReturnValue(now + TIMED_GRANT_DURATION_MS)
      // At exactly expiresAt, the check is `expiresAt < now`, so equal means NOT expired
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('returns prompt_needed one ms after timed grant expires', async () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      vi.spyOn(Date, 'now').mockReturnValue(now + TIMED_GRANT_DURATION_MS + 1)
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('reads persisted grants fresh on every check, so a change made elsewhere applies', async () => {
      mockGetSettings.mockReturnValue({
        computerUse: {
          agentPermissions: {
            'agent-1': {
              grants: [{ level: 'use_application', appName: 'Calculator', grantType: 'always' }],
            },
          },
        },
      })
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
      expect(mockGetSettings).toHaveBeenCalledTimes(1)
      // Revoked by another process: nothing tells this one, the next check sees it.
      mockGetSettings.mockReturnValue({})
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
      expect(mockGetSettings).toHaveBeenCalledTimes(2)
    })
  })

  // ─── Grant matching: appName semantics ────────────────────────────

  describe('appName matching', () => {
    it('use_application: requires exact appName match', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Safari')).toBe('prompt_needed')
    })

    it('use_application: a grant for no app covers nothing, so a call that names no app is always asked about', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', undefined)
      expect(await pm.checkPermission('agent-1', 'use_application', undefined)).toBe('prompt_needed')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
      // Nor is it kept: "always" for no app is for that call only.
      expect((await pm.getGrantsForAgent('agent-1')).filter((g) => g.grantType === 'always')).toEqual([])
    })

    it('use_application: grant with appName does NOT match undefined check', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'use_application', undefined)).toBe('prompt_needed')
    })

    it('list_apps_windows: ignores appName (level-only matching)', async () => {
      await pm.grantPermission('agent-1', 'list_apps_windows', 'once')
      expect(await pm.checkPermission('agent-1', 'list_apps_windows')).toBe('granted')
      expect(await pm.checkPermission('agent-1', 'list_apps_windows', 'Calculator')).toBe('granted')
    })

    it('use_host_shell: ignores appName (level-only matching)', async () => {
      await pm.grantPermission('agent-1', 'use_host_shell', 'once')
      expect(await pm.checkPermission('agent-1', 'use_host_shell')).toBe('granted')
      expect(await pm.checkPermission('agent-1', 'use_host_shell', 'Terminal')).toBe('granted')
    })

    it('different levels never match each other', async () => {
      await pm.grantPermission('agent-1', 'list_apps_windows', 'always')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
      expect(await pm.checkPermission('agent-1', 'use_host_shell')).toBe('prompt_needed')
    })
  })

  // ─── Multi-agent isolation ────────────────────────────────────────

  describe('agent isolation', () => {
    it('grants for one agent do not affect another', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
      expect(await pm.checkPermission('agent-2', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('revoking one agent does not affect others', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      await pm.grantPermission('agent-2', 'use_application', 'always', 'Calculator')
      await pm.revokeAllForAgent('agent-1')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
      expect(await pm.checkPermission('agent-2', 'use_application', 'Calculator')).toBe('granted')
    })
  })

  // ─── grantPermission ─────────────────────────────────────────────

  describe('grantPermission', () => {
    it('once grants can stack (multiple for same level/app)', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      // Both exist
      const grants = await pm.getGrantsForAgent('agent-1')
      expect(grants.filter(g => g.grantType === 'once')).toHaveLength(2)
    })

    it('timed grant replaces previous timed grant for same level/app', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      const grants = await pm.getGrantsForAgent('agent-1')
      expect(grants.filter(g => g.grantType === 'timed')).toHaveLength(1)
    })

    it('always grant replaces previous always grant for same level/app', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      const grants = await pm.getGrantsForAgent('agent-1')
      expect(grants.filter(g => g.grantType === 'always')).toHaveLength(1)
    })

    it('timed grant replaces existing matching grants (including once)', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      const grants = await pm.getGrantsForAgent('agent-1')
      // removeMatchingGrants removes all matching grants regardless of type
      expect(grants).toHaveLength(1)
      expect(grants[0].grantType).toBe('timed')
    })

    it('always grant persists to settings', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
      const call = mockUpdateSettings.mock.calls[0][0]
      expect(call.computerUse.agentPermissions['agent-1'].grants).toEqual([
        { level: 'use_application', appName: 'Calculator', grantType: 'always' },
      ])
    })

    it('once grant does NOT persist to settings', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('timed grant does NOT persist to settings', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('timed grant has expiresAt set', async () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      const grants = await pm.getGrantsForAgent('agent-1')
      expect(grants[0].expiresAt).toBe(now + TIMED_GRANT_DURATION_MS)
    })

    it('once grant has no expiresAt', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      const grants = await pm.getGrantsForAgent('agent-1')
      expect(grants[0].expiresAt).toBeUndefined()
    })

    it('always grant has no expiresAt', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      const grants = await pm.getGrantsForAgent('agent-1')
      expect(grants[0].expiresAt).toBeUndefined()
    })

    it('grants for different apps coexist', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Safari')
      const grants = await pm.getGrantsForAgent('agent-1')
      expect(grants).toHaveLength(2)
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Safari')).toBe('granted')
    })

    it('grants for different levels coexist', async () => {
      await pm.grantPermission('agent-1', 'list_apps_windows', 'always')
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      await pm.grantPermission('agent-1', 'use_host_shell', 'always')
      const grants = await pm.getGrantsForAgent('agent-1')
      expect(grants).toHaveLength(3)
    })

    it('grant without appName stores no appName field', async () => {
      await pm.grantPermission('agent-1', 'list_apps_windows', 'once')
      const grants = await pm.getGrantsForAgent('agent-1')
      expect('appName' in grants[0]).toBe(false)
    })
  })

  // ─── consumeOnceGrant ─────────────────────────────────────────────

  describe('consumeOnceGrant', () => {
    it('removes the first matching once grant', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('consumes only one when multiple once grants exist', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      // One should remain
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('does NOT consume timed grants', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('does NOT consume always grants', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('is a no-op for unknown agent', async () => {
      // Should not throw
      pm.consumeOnceGrant('unknown-agent', 'use_application', 'Calculator')
    })

    it('is a no-op when no matching grant exists', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Safari')
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      // Safari grant should still be there
      expect(await pm.checkPermission('agent-1', 'use_application', 'Safari')).toBe('granted')
    })

    it('matches appName strictly (undefined vs string)', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      pm.consumeOnceGrant('agent-1', 'use_application', undefined)
      // The Calculator grant is still there (no app matched nothing).
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })
  })

  // ─── revokeAllForAgent ────────────────────────────────────────────

  describe('revokeAllForAgent', () => {
    it('removes all grants for the agent', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Safari')
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Finder')
      await pm.revokeAllForAgent('agent-1')
      expect(await pm.getGrantsForAgent('agent-1')).toHaveLength(0)
    })

    it('forgets the active app', async () => {
      pm.setActiveApp('agent-1', 's1', 'Calculator')
      await pm.revokeAllForAgent('agent-1')
      expect(pm.getActiveApp('agent-1', 's1')).toBeUndefined()
    })

    it('persists to settings', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      mockUpdateSettings.mockClear()
      await pm.revokeAllForAgent('agent-1')
      expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    })

    it('is safe to call for unknown agent', async () => {
      await pm.revokeAllForAgent('nonexistent')
      expect(await pm.getGrantsForAgent('nonexistent')).toHaveLength(0)
    })
  })

  // ─── revokeGrant ──────────────────────────────────────────────────

  describe('revokeGrant', () => {
    it('removes matching grants', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      await pm.revokeGrant('agent-1', 'use_application', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('does not remove grants for different apps', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Safari')
      await pm.revokeGrant('agent-1', 'use_application', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Safari')).toBe('granted')
    })

    it('does not remove grants for different levels', async () => {
      await pm.grantPermission('agent-1', 'list_apps_windows', 'always')
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      await pm.revokeGrant('agent-1', 'use_application', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'list_apps_windows')).toBe('granted')
    })

    it('persists to settings', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      mockUpdateSettings.mockClear()
      await pm.revokeGrant('agent-1', 'use_application', 'Calculator')
      expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    })
  })

  // ─── getGrantsForAgent ────────────────────────────────────────────

  describe('getGrantsForAgent', () => {
    it('returns empty array for unknown agent', async () => {
      expect(await pm.getGrantsForAgent('agent-1')).toEqual([])
    })

    it('filters out expired timed grants', async () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Safari')
      // Fast-forward past expiry
      vi.spyOn(Date, 'now').mockReturnValue(now + TIMED_GRANT_DURATION_MS + 1)
      const grants = await pm.getGrantsForAgent('agent-1')
      expect(grants).toHaveLength(1)
      expect(grants[0].appName).toBe('Safari')
    })

    it('includes non-expired timed grants', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      const grants = await pm.getGrantsForAgent('agent-1')
      expect(grants).toHaveLength(1)
    })

    it('always includes once and always grants', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Safari')
      const grants = await pm.getGrantsForAgent('agent-1')
      expect(grants).toHaveLength(2)
    })
  })

  // ─── Grabbed app tracking ─────────────────────────────────────────

  describe('grabbed app tracking', () => {
    it('setActiveApp / getActiveApp round-trip', () => {
      pm.setActiveApp('agent-1', 's1', 'Calculator')
      expect(pm.getActiveApp('agent-1', 's1')).toBe('Calculator')
    })

    it('getActiveApp returns undefined for unknown agent', () => {
      expect(pm.getActiveApp('agent-1', 's1')).toBeUndefined()
    })

    it('clearActiveApp removes the entry', () => {
      pm.setActiveApp('agent-1', 's1', 'Calculator')
      pm.clearActiveApp('agent-1')
      expect(pm.getActiveApp('agent-1', 's1')).toBeUndefined()
    })

    it('setActiveApp overwrites previous value', () => {
      pm.setActiveApp('agent-1', 's1', 'Calculator')
      pm.setActiveApp('agent-1', 's1', 'Safari')
      expect(pm.getActiveApp('agent-1', 's1')).toBe('Safari')
    })

    it('agents have independent active apps', () => {
      pm.setActiveApp('agent-1', 's1', 'Calculator')
      pm.setActiveApp('agent-2', 's1', 'Safari')
      expect(pm.getActiveApp('agent-1', 's1')).toBe('Calculator')
      expect(pm.getActiveApp('agent-2', 's1')).toBe('Safari')
    })
  })

  // ─── Settings persistence round-trip ──────────────────────────────

  describe('settings persistence', () => {
    it('reading persisted grants loads always grants from settings', async () => {
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
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
      expect(await pm.checkPermission('agent-1', 'list_apps_windows')).toBe('granted')
    })

    it('reading persisted grants handles missing computerUse gracefully', async () => {
      mockGetSettings.mockReturnValue({})
      // Should not throw
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('reading persisted grants handles missing agentPermissions gracefully', async () => {
      mockGetSettings.mockReturnValue({ computerUse: {} })
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('reading persisted grants handles error gracefully', async () => {
      mockGetSettings.mockImplementation(() => { throw new Error('disk error') })
      // Should not throw, should return prompt_needed
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('persisting only saves always grants', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Safari')
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Finder')
      // Only 'always' call triggers persist, check the latest call
      const lastCall = mockUpdateSettings.mock.calls[mockUpdateSettings.mock.calls.length - 1][0]
      const saved = lastCall.computerUse.agentPermissions['agent-1'].grants
      expect(saved).toEqual([
        { level: 'use_application', appName: 'Finder', grantType: 'always' },
      ])
    })

    it('persisting removes agent entry when no always grants remain', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      await pm.revokeGrant('agent-1', 'use_application', 'Calculator')
      const lastCall = mockUpdateSettings.mock.calls[mockUpdateSettings.mock.calls.length - 1][0]
      expect(lastCall.computerUse.agentPermissions['agent-1']).toBeUndefined()
    })

    it('persisting handles error gracefully', async () => {
      mockUpdateSettings.mockImplementation(() => { throw new Error('disk error') })
      // Should not throw
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
    })

    it('reading persisted grants merges with existing in-memory grants', async () => {
      mockGetSettings.mockReturnValue({
        computerUse: {
          agentPermissions: {
            'agent-1': {
              grants: [{ level: 'use_application', appName: 'Calculator', grantType: 'always' }],
            },
          },
        },
      })
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Safari')
      // Both the persisted 'always' for Calculator and the in-memory 'once' for Safari count
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Safari')).toBe('granted')
    })

    it('persists multiple agents correctly', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      await pm.grantPermission('agent-2', 'use_host_shell', 'always')
      const lastCall = mockUpdateSettings.mock.calls[mockUpdateSettings.mock.calls.length - 1][0]
      expect(lastCall.computerUse.agentPermissions['agent-1']).toBeDefined()
      expect(lastCall.computerUse.agentPermissions['agent-2']).toBeDefined()
    })
  })

  // ─── Edge cases and stress scenarios ──────────────────────────────

  describe('edge cases', () => {
    it('empty string appName is treated as falsy (no appName field stored)', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', '')
      const grants = await pm.getGrantsForAgent('agent-1')
      // Empty string is falsy, so appName should NOT be set
      expect('appName' in grants[0]).toBe(false)
    })

    it('many grants for same agent do not leak or corrupt', async () => {
      for (let i = 0; i < 100; i++) {
        await pm.grantPermission('agent-1', 'use_application', 'once', `App${i}`)
      }
      expect(await pm.getGrantsForAgent('agent-1')).toHaveLength(100)
      // Consume a few
      for (let i = 0; i < 10; i++) {
        pm.consumeOnceGrant('agent-1', 'use_application', `App${i}`)
      }
      expect(await pm.getGrantsForAgent('agent-1')).toHaveLength(90)
    })

    it('timed grant replaced by new timed grant resets expiry', async () => {
      const t1 = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(t1)
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')

      const t2 = t1 + 10 * 60 * 1000 // 10 minutes later
      vi.spyOn(Date, 'now').mockReturnValue(t2)
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')

      // At t1 + 16 minutes: first would have expired, but second should still be valid
      vi.spyOn(Date, 'now').mockReturnValue(t2 + 14 * 60 * 1000)
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('revokeGrant with undefined appName removes undefined-appName grants', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', undefined)
      await pm.revokeGrant('agent-1', 'use_application', undefined)
      expect(await pm.checkPermission('agent-1', 'use_application', undefined)).toBe('prompt_needed')
    })

    it('revokeGrant with undefined appName does NOT remove named grants', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      await pm.revokeGrant('agent-1', 'use_application', undefined)
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('granted')
    })

    it('once + timed + always for same app: each non-once replaces all prior', async () => {
      // Granting timed replaces the once, granting always replaces the timed
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'timed', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Calculator')
      const grants = await pm.getGrantsForAgent('agent-1')
      expect(grants).toHaveLength(1)
      expect(grants[0].grantType).toBe('always')
    })

    it('once grant alongside always for different app is preserved', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      await pm.grantPermission('agent-1', 'use_application', 'always', 'Safari')
      pm.consumeOnceGrant('agent-1', 'use_application', 'Calculator')
      // Safari always should still be there
      expect(await pm.checkPermission('agent-1', 'use_application', 'Safari')).toBe('granted')
      expect(await pm.checkPermission('agent-1', 'use_application', 'Calculator')).toBe('prompt_needed')
    })

    it('case-sensitive appName matching', async () => {
      await pm.grantPermission('agent-1', 'use_application', 'once', 'Calculator')
      expect(await pm.checkPermission('agent-1', 'use_application', 'calculator')).toBe('prompt_needed')
      expect(await pm.checkPermission('agent-1', 'use_application', 'CALCULATOR')).toBe('prompt_needed')
    })
  })
})
