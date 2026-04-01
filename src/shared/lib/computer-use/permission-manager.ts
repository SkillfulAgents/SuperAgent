/**
 * ComputerUsePermissionManager
 *
 * Manages per-agent computer use permissions. Extends BasePermissionManager
 * with exact app-name matching for 'use_application' level.
 *
 * Also tracks per-agent "grabbed app" state.
 */

import { getSettings, updateSettings } from '@shared/lib/config/settings'
import { BasePermissionManager } from '@shared/lib/permissions/base-permission-manager'
import type { PermissionGrant } from '@shared/lib/permissions/types'
import type {
  ComputerUsePermissionLevel,
  PermissionGrant as LegacyPermissionGrant,
  PermissionGrantType,
  ComputerUseSettings,
} from './types'

export class ComputerUsePermissionManager extends BasePermissionManager<ComputerUsePermissionLevel> {
  private grabbedApps = new Map<string, string>()

  constructor() {
    super('ComputerUsePermissions')
  }

  checkPermission(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    appName?: string,
  ): 'granted' | 'prompt_needed' {
    return super.checkPermission(agentSlug, level, appName)
  }

  grantPermission(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    grantType: PermissionGrantType,
    appName?: string,
  ): void {
    super.grantPermission(agentSlug, level, grantType, appName)
  }

  consumeOnceGrant(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    appName?: string,
  ): void {
    super.consumeOnceGrant(agentSlug, level, appName)
  }

  revokeGrant(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    appName?: string,
  ): void {
    super.revokeGrant(agentSlug, level, appName)
  }

  revokeAllForAgent(agentSlug: string): void {
    this.grabbedApps.delete(agentSlug)
    super.revokeAllForAgent(agentSlug)
  }

  getGrantsForAgent(agentSlug: string): LegacyPermissionGrant[] {
    return super.getGrantsForAgent(agentSlug).map((g) => {
      const result: LegacyPermissionGrant = {
        level: g.level,
        grantType: g.grantType,
        grantedAt: g.grantedAt,
      }
      if (g.scope) result.appName = g.scope
      if (g.expiresAt) result.expiresAt = g.expiresAt
      return result
    })
  }

  // --- Grabbed app tracking ---

  setGrabbedApp(agentSlug: string, appName: string): void {
    this.grabbedApps.set(agentSlug, appName)
  }

  clearGrabbedApp(agentSlug: string): void {
    this.grabbedApps.delete(agentSlug)
  }

  getGrabbedApp(agentSlug: string): string | undefined {
    return this.grabbedApps.get(agentSlug)
  }

  // --- Settings serialization (maps scope ↔ appName) ---

  loadFromSettings(): void {
    try {
      const settings = getSettings()
      const cu = settings.computerUse as ComputerUseSettings | undefined
      if (!cu?.agentPermissions) return

      for (const [agentSlug, agentPerms] of Object.entries(cu.agentPermissions)) {
        const existingGrants = this.grants.get(agentSlug) || []
        for (const g of agentPerms.grants) {
          existingGrants.push({
            level: g.level,
            scope: g.appName,
            grantType: 'always',
            grantedAt: Date.now(),
          })
        }
        this.grants.set(agentSlug, existingGrants)
      }
    } catch (error) {
      console.error(`[${this.logPrefix}] Failed to load from settings:`, error)
    }
  }

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
              appName: g.scope,
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
      console.error(`[${this.logPrefix}] Failed to persist to settings:`, error)
    }
  }

  // --- Grant matching ---

  protected grantMatches(
    grant: PermissionGrant<ComputerUsePermissionLevel>,
    level: ComputerUsePermissionLevel,
    scope?: string,
  ): boolean {
    if (grant.level !== level) return false
    if (level === 'use_application') {
      return grant.scope === scope
    }
    return true
  }
}

/** Singleton instance */
export const computerUsePermissionManager = new ComputerUsePermissionManager()
