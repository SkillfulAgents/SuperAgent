/**
 * BrowserUsePermissionManager
 *
 * Manages per-agent browser use permissions. Extends BasePermissionManager
 * with domain subdomain matching for domain-scoped levels.
 */

import { getSettings, updateSettings } from '@shared/lib/config/settings'
import { BasePermissionManager } from '@shared/lib/permissions/base-permission-manager'
import type { PermissionGrant } from '@shared/lib/permissions/types'
import type { BrowserUsePermissionLevel, BrowserUseSettings } from './types'
import { DOMAIN_SCOPED_LEVELS, domainMatches } from './types'

export class BrowserUsePermissionManager extends BasePermissionManager<BrowserUsePermissionLevel> {
  constructor() {
    super('BrowserUsePermissions')
  }

  // --- Settings serialization (maps scope ↔ domain) ---

  loadFromSettings(): void {
    try {
      const settings = getSettings()
      const bu = settings.browserUse as BrowserUseSettings | undefined
      if (!bu?.agentPermissions) return

      for (const [agentSlug, agentPerms] of Object.entries(bu.agentPermissions)) {
        const existingGrants = this.grants.get(agentSlug) || []
        for (const g of agentPerms.grants) {
          existingGrants.push({
            level: g.level,
            scope: g.domain,
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
      const agentPermissions: BrowserUseSettings['agentPermissions'] = {}

      for (const [agentSlug, agentGrants] of this.grants) {
        const alwaysGrants = agentGrants.filter((g) => g.grantType === 'always')
        if (alwaysGrants.length > 0) {
          agentPermissions[agentSlug] = {
            grants: alwaysGrants.map((g) => ({
              level: g.level,
              domain: g.scope,
              grantType: 'always' as const,
            })),
          }
        }
      }

      updateSettings({
        ...settings,
        browserUse: {
          ...settings.browserUse,
          agentPermissions,
        },
      })
    } catch (error) {
      console.error(`[${this.logPrefix}] Failed to persist to settings:`, error)
    }
  }

  // --- Grant matching ---

  protected grantMatches(
    grant: PermissionGrant<BrowserUsePermissionLevel>,
    level: BrowserUsePermissionLevel,
    scope?: string,
  ): boolean {
    if (grant.level !== level) return false
    if (DOMAIN_SCOPED_LEVELS.has(level)) {
      return domainMatches(grant.scope, scope)
    }
    return true
  }
}

/** Singleton instance */
export const browserUsePermissionManager = new BrowserUsePermissionManager()
