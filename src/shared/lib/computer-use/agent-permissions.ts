/**
 * One agent's computer-use permissions and the app it has grabbed.
 *
 * Three grant types:
 * - "once": in-memory only, consumed after single use
 * - "timed": in-memory with 15-min expiry
 * - "always": persisted to settings.json + in-memory
 *
 * Owned by the agent's actor. The persisted "always" grants are read from
 * settings.json on first use and written back per agent, so one agent's
 * revoke never rewrites another's entry; the in-memory grants and the grab
 * die with the actor.
 */
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import type { ComputerUsePermissionLevel, PermissionGrant, PermissionGrantType } from './types'
import { TIMED_GRANT_DURATION_MS } from './types'

export class AgentComputerUse {
  private grants: PermissionGrant[] = []

  /** The app this agent has grabbed, if any. */
  private grabbedApp: string | undefined

  /** Whether the persisted grants have been loaded from settings.json yet. */
  private loaded = false

  constructor(readonly slug: AgentSlug) {}

  /** Lazily load persisted grants on first access. */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    this.loadFromSettings()
  }

  /**
   * Check if a permission is currently granted.
   * Returns 'granted' if an active (non-expired, non-consumed) grant exists.
   * Returns 'prompt_needed' if the user must be prompted.
   */
  check(level: ComputerUsePermissionLevel, appName?: string): 'granted' | 'prompt_needed' {
    this.ensureLoaded()
    const now = Date.now()
    for (const grant of this.grants) {
      if (!this.grantMatches(grant, level, appName)) continue
      // Check expiry for timed grants
      if (grant.grantType === 'timed' && grant.expiresAt && grant.expiresAt < now) continue
      return 'granted'
    }
    return 'prompt_needed'
  }

  /** Record a permission grant. For "always" grants, also persists to settings. */
  grant(level: ComputerUsePermissionLevel, grantType: PermissionGrantType, appName?: string): void {
    this.ensureLoaded()
    const now = Date.now()
    const grant: PermissionGrant = {
      level,
      grantType,
      grantedAt: now,
      ...(appName && { appName }),
      ...(grantType === 'timed' && { expiresAt: now + TIMED_GRANT_DURATION_MS }),
    }

    // For 'timed' and 'always': remove existing matching grants before adding new one
    if (grantType !== 'once') {
      this.removeMatchingGrants(level, appName)
    }

    this.grants.push(grant)
    console.log(`[ComputerUsePermissions] Granted ${grantType} ${level}${appName ? ` for ${appName}` : ''} to ${this.slug}`)

    if (grantType === 'always') {
      this.persistToSettings()
    }
  }

  /** Consume a "once" grant after use. Removes the first matching "once" grant. */
  consumeOnce(level: ComputerUsePermissionLevel, appName?: string): void {
    const idx = this.grants.findIndex((g) => g.grantType === 'once' && this.grantMatches(g, level, appName))
    if (idx >= 0) {
      this.grants.splice(idx, 1)
      console.log(`[ComputerUsePermissions] Consumed once grant ${level}${appName ? ` for ${appName}` : ''} from ${this.slug}`)
    }
  }

  /** Revoke every permission, persisted ones included, and drop the grab. */
  revokeAll(): void {
    console.log(`[ComputerUsePermissions] Revoking all grants for ${this.slug}`)
    this.loaded = true
    this.grants = []
    this.grabbedApp = undefined
    this.persistToSettings()
  }

  /** Revoke the grants matching a level (and app), persisted ones included. */
  revoke(level: ComputerUsePermissionLevel, appName?: string): void {
    console.log(`[ComputerUsePermissions] Revoking ${level}${appName ? ` for ${appName}` : ''} from ${this.slug}`)
    this.ensureLoaded()
    this.removeMatchingGrants(level, appName)
    this.persistToSettings()
  }

  /** All active (non-expired) grants. */
  activeGrants(): PermissionGrant[] {
    this.ensureLoaded()
    const now = Date.now()
    return this.grants.filter((g) => !(g.grantType === 'timed' && g.expiresAt && g.expiresAt < now))
  }

  /** The app the agent's session has grabbed, if any. */
  grabbed(): string | undefined {
    return this.grabbedApp
  }

  setGrabbed(appName: string): void {
    this.grabbedApp = appName
  }

  clearGrabbed(): void {
    this.grabbedApp = undefined
  }

  /** Load this agent's persisted "always" grants from settings.json. */
  private loadFromSettings(): void {
    try {
      const persisted = getSettings().computerUse?.agentPermissions?.[this.slug]
      if (!persisted) return
      for (const g of persisted.grants) {
        this.grants.push({
          level: g.level,
          appName: g.appName,
          grantType: 'always',
          grantedAt: Date.now(),
        })
      }
    } catch (error) {
      console.error(`[ComputerUsePermissions] Failed to load grants for ${this.slug} from settings:`, error)
    }
  }

  /**
   * Persist this agent's "always" grants to settings.json: its entry alone,
   * written or removed, with every other agent's entry left as it is.
   */
  private persistToSettings(): void {
    try {
      const alwaysGrants = this.grants.filter((g) => g.grantType === 'always')
      // Serialized fresh-read + atomic write: preserves any concurrent
      // settings change instead of overwriting from a stale snapshot.
      mutateSettings((settings) => {
        const agentPermissions = { ...settings.computerUse?.agentPermissions }
        if (alwaysGrants.length > 0) {
          agentPermissions[this.slug] = {
            grants: alwaysGrants.map((g) => ({
              level: g.level,
              appName: g.appName,
              grantType: 'always' as const,
            })),
          }
        } else {
          delete agentPermissions[this.slug]
        }
        settings.computerUse = { ...settings.computerUse, agentPermissions }
      })
    } catch (error) {
      console.error(`[ComputerUsePermissions] Failed to persist grants for ${this.slug} to settings:`, error)
    }
  }

  // --- Private helpers ---

  private grantMatches(grant: PermissionGrant, level: ComputerUsePermissionLevel, appName?: string): boolean {
    if (grant.level !== level) return false
    // For 'use_application', appName must match
    if (level === 'use_application') {
      return grant.appName === appName
    }
    return true
  }

  private removeMatchingGrants(level: ComputerUsePermissionLevel, appName?: string): void {
    this.grants = this.grants.filter((g) => !this.grantMatches(g, level, appName))
  }
}
