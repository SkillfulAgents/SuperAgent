/**
 * BasePermissionManager
 *
 * Shared logic for per-agent permission management with three grant types:
 * - "once": in-memory only, consumed after single use
 * - "timed": in-memory with 15-min expiry
 * - "always": persisted to settings.json + in-memory
 *
 * Subclasses implement grant matching and settings serialization.
 */

import type { PermissionGrant, PermissionGrantType } from './types'
import { TIMED_GRANT_DURATION_MS } from './types'

export abstract class BasePermissionManager<TLevel extends string> {
  protected grants = new Map<string, PermissionGrant<TLevel>[]>()
  protected loaded = false

  constructor(protected readonly logPrefix: string) {}

  protected ensureLoaded(): void {
    if (!this.loaded) {
      this.loaded = true
      this.loadFromSettings()
    }
  }

  checkPermission(
    agentSlug: string,
    level: TLevel,
    scope?: string,
  ): 'granted' | 'prompt_needed' {
    this.ensureLoaded()
    const agentGrants = this.grants.get(agentSlug)
    if (!agentGrants) return 'prompt_needed'

    const now = Date.now()
    for (const grant of agentGrants) {
      if (!this.grantMatches(grant, level, scope)) continue
      if (grant.grantType === 'timed' && grant.expiresAt && grant.expiresAt < now) continue
      return 'granted'
    }

    return 'prompt_needed'
  }

  grantPermission(
    agentSlug: string,
    level: TLevel,
    grantType: PermissionGrantType,
    scope?: string,
  ): void {
    this.ensureLoaded()
    const now = Date.now()
    const grant: PermissionGrant<TLevel> = {
      level,
      grantType,
      grantedAt: now,
      ...(scope && { scope }),
      ...(grantType === 'timed' && { expiresAt: now + TIMED_GRANT_DURATION_MS }),
    }

    if (!this.grants.has(agentSlug)) {
      this.grants.set(agentSlug, [])
    }

    if (grantType !== 'once') {
      this.removeMatchingGrants(agentSlug, level, scope)
    }

    this.grants.get(agentSlug)!.push(grant)
    console.log(`[${this.logPrefix}] Granted ${grantType} ${level}${scope ? ` for ${scope}` : ''} to ${agentSlug}`)

    if (grantType === 'always') {
      this.persistToSettings()
    }
  }

  consumeOnceGrant(
    agentSlug: string,
    level: TLevel,
    scope?: string,
  ): void {
    const agentGrants = this.grants.get(agentSlug)
    if (!agentGrants) return

    const idx = agentGrants.findIndex(
      (g) => g.grantType === 'once' && this.grantMatches(g, level, scope),
    )
    if (idx >= 0) {
      agentGrants.splice(idx, 1)
    }
  }

  revokeAllForAgent(agentSlug: string): void {
    this.grants.delete(agentSlug)
    this.persistToSettings()
  }

  revokeGrant(
    agentSlug: string,
    level: TLevel,
    scope?: string,
  ): void {
    this.removeMatchingGrants(agentSlug, level, scope)
    this.persistToSettings()
  }

  getGrantsForAgent(agentSlug: string): PermissionGrant<TLevel>[] {
    this.ensureLoaded()
    const agentGrants = this.grants.get(agentSlug)
    if (!agentGrants) return []

    const now = Date.now()
    return agentGrants.filter((g) => {
      if (g.grantType === 'timed' && g.expiresAt && g.expiresAt < now) return false
      return true
    })
  }

  // --- Abstract methods ---

  protected abstract grantMatches(
    grant: PermissionGrant<TLevel>,
    level: TLevel,
    scope?: string,
  ): boolean

  abstract loadFromSettings(): void
  abstract persistToSettings(): void

  // --- Private helpers ---

  private removeMatchingGrants(
    agentSlug: string,
    level: TLevel,
    scope?: string,
  ): void {
    const agentGrants = this.grants.get(agentSlug)
    if (!agentGrants) return
    this.grants.set(agentSlug, agentGrants.filter((g) => !this.grantMatches(g, level, scope)))
  }
}
