/**
 * ComputerUsePermissionManager
 *
 * Manages per-agent computer use permissions with three grant types:
 * - "once": in-memory only, consumed after single use
 * - "timed": in-memory with 15-min expiry
 * - "always": persisted to settings.json + in-memory
 */

import { getSettings, updateSettings } from '@shared/lib/config/settings'
import type {
  ComputerUsePermissionLevel,
  PermissionGrant,
  PermissionGrantType,
  ComputerUseSettings,
} from './types'
import { TIMED_GRANT_DURATION_MS } from './types'

export class ComputerUsePermissionManager {
  /** In-memory grants: agentSlug → grants[] */
  private grants = new Map<string, PermissionGrant[]>()

  /** Per-agent grabbed app tracking: agentSlug → app name */
  private grabbedApps = new Map<string, string>()

  /** Whether persisted grants have been loaded from settings.json yet. */
  private loaded = false

  /** Lazily load persisted grants on first access. */
  private ensureLoaded(): void {
    if (!this.loaded) {
      this.loaded = true
      this.loadFromSettings()
    }
  }

  /**
   * Check if a permission is currently granted.
   * Returns 'granted' if an active (non-expired, non-consumed) grant exists.
   * Returns 'prompt_needed' if the user must be prompted.
   */
  checkPermission(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    appName?: string,
  ): 'granted' | 'prompt_needed' {
    this.ensureLoaded()
    const agentGrants = this.grants.get(agentSlug)
    if (!agentGrants) return 'prompt_needed'

    const now = Date.now()
    for (const grant of agentGrants) {
      if (!this.grantMatches(grant, level, appName)) continue
      // Check expiry for timed grants
      if (grant.grantType === 'timed' && grant.expiresAt && grant.expiresAt < now) continue
      return 'granted'
    }

    return 'prompt_needed'
  }

  /**
   * Record a permission grant. For "always" grants, also persists to settings.
   */
  grantPermission(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    grantType: PermissionGrantType,
    appName?: string,
  ): void {
    this.ensureLoaded()
    const now = Date.now()
    const grant: PermissionGrant = {
      level,
      grantType,
      grantedAt: now,
      ...(appName && { appName }),
      ...(grantType === 'timed' && { expiresAt: now + TIMED_GRANT_DURATION_MS }),
    }

    if (!this.grants.has(agentSlug)) {
      this.grants.set(agentSlug, [])
    }

    // For 'timed' and 'always': remove existing matching grants before adding new one
    if (grantType !== 'once') {
      this.removeMatchingGrants(agentSlug, level, appName)
    }

    this.grants.get(agentSlug)!.push(grant)
    console.log(`[ComputerUsePermissions] Granted ${grantType} ${level}${appName ? ` for ${appName}` : ''} to ${agentSlug}`)

    if (grantType === 'always') {
      this.persistToSettings()
    }
  }

  /**
   * Consume a "once" grant after use. Removes the first matching "once" grant.
   */
  consumeOnceGrant(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    appName?: string,
  ): void {
    const agentGrants = this.grants.get(agentSlug)
    if (!agentGrants) return

    const idx = agentGrants.findIndex(
      (g) => g.grantType === 'once' && this.grantMatches(g, level, appName),
    )
    if (idx >= 0) {
      agentGrants.splice(idx, 1)
      console.log(`[ComputerUsePermissions] Consumed once grant ${level}${appName ? ` for ${appName}` : ''} from ${agentSlug}`)
    }
  }

  /**
   * Revoke all permissions for an agent.
   */
  revokeAllForAgent(agentSlug: string): void {
    console.log(`[ComputerUsePermissions] Revoking all grants for ${agentSlug}`)
    this.grants.delete(agentSlug)
    this.grabbedApps.delete(agentSlug)
    this.persistToSettings()
  }

  /**
   * Revoke a specific "always" grant for an agent.
   */
  revokeGrant(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    appName?: string,
  ): void {
    console.log(`[ComputerUsePermissions] Revoking ${level}${appName ? ` for ${appName}` : ''} from ${agentSlug}`)
    this.removeMatchingGrants(agentSlug, level, appName)
    this.persistToSettings()
  }

  /**
   * Get all active (non-expired) grants for an agent.
   */
  getGrantsForAgent(agentSlug: string): PermissionGrant[] {
    this.ensureLoaded()
    const agentGrants = this.grants.get(agentSlug)
    if (!agentGrants) return []

    const now = Date.now()
    return agentGrants.filter((g) => {
      if (g.grantType === 'timed' && g.expiresAt && g.expiresAt < now) return false
      return true
    })
  }

  /**
   * Track which app is currently grabbed by an agent session.
   */
  setGrabbedApp(agentSlug: string, appName: string): void {
    this.grabbedApps.set(agentSlug, appName)
  }

  clearGrabbedApp(agentSlug: string): void {
    this.grabbedApps.delete(agentSlug)
  }

  getGrabbedApp(agentSlug: string): string | undefined {
    return this.grabbedApps.get(agentSlug)
  }

  /**
   * Load persisted "always" grants from settings.json on startup.
   */
  loadFromSettings(): void {
    try {
      const settings = getSettings()
      const cu = settings.computerUse
      if (!cu?.agentPermissions) return

      for (const [agentSlug, agentPerms] of Object.entries(cu.agentPermissions)) {
        const existingGrants = this.grants.get(agentSlug) || []
        for (const g of agentPerms.grants) {
          existingGrants.push({
            level: g.level,
            appName: g.appName,
            grantType: 'always',
            grantedAt: Date.now(),
          })
        }
        this.grants.set(agentSlug, existingGrants)
      }
    } catch (error) {
      console.error('[ComputerUsePermissionManager] Failed to load from settings:', error)
    }
  }

  /**
   * Persist all "always" grants to settings.json.
   */
  persistToSettings(): void {
    try {
      const settings = getSettings()
      const agentPermissions: ComputerUseSettings['agentPermissions'] = {}

      for (const [agentSlug, agentGrants] of this.grants) {
        const alwaysGrants = agentGrants.filter((g) => g.grantType === 'always')
        if (alwaysGrants.length > 0) {
          agentPermissions[agentSlug] = {
            grants: alwaysGrants.map((g) => ({
              level: g.level,
              appName: g.appName,
              grantType: 'always' as const,
            })),
          }
        }
      }

      updateSettings({
        ...settings,
        computerUse: {
          ...settings.computerUse,
          agentPermissions,
        },
      })
    } catch (error) {
      console.error('[ComputerUsePermissionManager] Failed to persist to settings:', error)
    }
  }

  // --- Private helpers ---

  private grantMatches(
    grant: PermissionGrant,
    level: ComputerUsePermissionLevel,
    appName?: string,
  ): boolean {
    if (grant.level !== level) return false
    // For 'use_application', appName must match
    if (level === 'use_application') {
      return grant.appName === appName
    }
    return true
  }

  private removeMatchingGrants(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    appName?: string,
  ): void {
    const agentGrants = this.grants.get(agentSlug)
    if (!agentGrants) return

    const filtered = agentGrants.filter((g) => !this.grantMatches(g, level, appName))
    this.grants.set(agentSlug, filtered)
  }
}

/** Singleton instance */
export const computerUsePermissionManager = new ComputerUsePermissionManager()
