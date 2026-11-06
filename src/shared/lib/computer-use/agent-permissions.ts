/**
 * One agent's computer-use permissions and the app its last command acted in.
 *
 * Three grant types:
 * - "once": in-memory only, consumed after single use
 * - "timed": in-memory with 15-min expiry
 * - "always": persisted to settings only
 *
 * Besides those, a session the user started with computer use on (the
 * dispatch launcher's toggle) may list and use any app without asking. That
 * grant is the session's alone and lives in memory only; host shell scripts
 * still ask.
 *
 * Owned by the agent's actor. The persisted "always" grants are not held
 * here: they are read from settings whenever a check needs them (another
 * process may change them, and nothing would tell this one) and written back
 * per agent, so one agent's revoke never rewrites another's entry. The
 * in-memory grants and the active app die with the actor.
 */
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import type { ComputerUsePermissionLevel, ComputerUseSettings, PermissionGrant, PermissionGrantType } from './types'
import { TIMED_GRANT_DURATION_MS } from './types'

/** An "always" grant as settings store it. */
type PersistedGrant = NonNullable<ComputerUseSettings['agentPermissions']>[string]['grants'][number]

/** Drop app grants saved without their app (an earlier bug): they cover nothing (grantMatches). */
function coversSomething(grants: readonly PersistedGrant[]): PersistedGrant[] {
  return grants.filter((g) => !(g.level === 'use_application' && !g.appName))
}

export class AgentComputerUse {
  /** The in-memory grants: "once" and "timed" ("always" ones live in settings). */
  private grants: PermissionGrant[] = []

  /** Sessions that may list and use any app without asking. */
  private appAccessSessions = new Set<string>()

  /** The app each session's last computer-use command acted in. */
  private activeApps = new Map<string, string>()

  constructor(readonly slug: AgentSlug) {}

  /**
   * Check if a permission is currently granted.
   * Returns 'granted' if an active (non-expired, non-consumed) grant exists,
   * in memory or persisted.
   * Returns 'prompt_needed' if the user must be prompted. `sessionId` is the
   * session making the call, for its own grant (`grantSession`).
   */
  async check(level: ComputerUsePermissionLevel, appName?: string, sessionId?: string): Promise<'granted' | 'prompt_needed'> {
    if (sessionId && level !== 'use_host_shell' && this.appAccessSessions.has(sessionId)) return 'granted'
    const now = Date.now()
    for (const grant of this.grants) {
      if (!this.grantMatches(grant, level, appName)) continue
      // Check expiry for timed grants
      if (grant.grantType === 'timed' && grant.expiresAt && grant.expiresAt < now) continue
      return 'granted'
    }
    for (const grant of await this.readPersisted()) {
      if (this.grantMatches(grant, level, appName)) return 'granted'
    }
    return 'prompt_needed'
  }

  /** Record a permission grant. "always" grants go to settings, the others to memory. */
  async grant(level: ComputerUsePermissionLevel, grantType: PermissionGrantType, appName?: string): Promise<void> {
    // An app grant for no app would cover nothing later (grantMatches): it is for this call only.
    if (level === 'use_application' && !appName) grantType = 'once'
    const now = Date.now()

    // For 'timed' and 'always': remove existing matching grants before adding new one
    if (grantType !== 'once') {
      this.removeMatchingGrants(level, appName)
    }

    console.log(`[ComputerUsePermissions] Granted ${grantType} ${level}${appName ? ` for ${appName}` : ''} to ${this.slug}`)

    if (grantType === 'always') {
      await this.writePersisted((grants) => [
        ...grants.filter((g) => !this.grantMatches(g, level, appName)),
        { level, appName, grantType: 'always' },
      ])
      return
    }

    this.grants.push({
      level,
      grantType,
      grantedAt: now,
      ...(appName && { appName }),
      ...(grantType === 'timed' && { expiresAt: now + TIMED_GRANT_DURATION_MS }),
    })
  }

  /** Consume a "once" grant after use. Removes the first matching "once" grant. */
  consumeOnce(level: ComputerUsePermissionLevel, appName?: string): void {
    const idx = this.grants.findIndex((g) => g.grantType === 'once' && this.grantMatches(g, level, appName))
    if (idx >= 0) {
      this.grants.splice(idx, 1)
      console.log(`[ComputerUsePermissions] Consumed once grant ${level}${appName ? ` for ${appName}` : ''} from ${this.slug}`)
    }
  }

  /**
   * Let one session list and use any app without asking, for as long as this
   * actor lives. Host shell scripts still ask.
   */
  grantSession(sessionId: string): void {
    this.appAccessSessions.add(sessionId)
    console.log(`[ComputerUsePermissions] Granted any app to session ${sessionId} of ${this.slug}`)
  }

  /** End a session's own grant (`grantSession`). */
  revokeSession(sessionId: string): void {
    if (this.appAccessSessions.delete(sessionId)) {
      console.log(`[ComputerUsePermissions] Revoked the any-app grant of session ${sessionId} of ${this.slug}`)
    }
  }

  /** Revoke every permission, persisted and session ones included, and forget the active app. */
  async revokeAll(): Promise<void> {
    console.log(`[ComputerUsePermissions] Revoking all grants for ${this.slug}`)
    this.grants = []
    this.appAccessSessions.clear()
    this.activeApps.clear()
    await this.writePersisted(() => [])
  }

  /** Revoke the grants matching a level (and app), persisted ones included. */
  async revoke(level: ComputerUsePermissionLevel, appName?: string): Promise<void> {
    console.log(`[ComputerUsePermissions] Revoking ${level}${appName ? ` for ${appName}` : ''} from ${this.slug}`)
    this.removeMatchingGrants(level, appName)
    await this.writePersisted((grants) => grants.filter((g) => !this.grantMatches(g, level, appName)))
  }

  /** All active (non-expired) grants: the persisted ones, then the in-memory ones. */
  async activeGrants(): Promise<PermissionGrant[]> {
    const persisted = await this.readPersisted()
    const now = Date.now()
    return [
      ...persisted.map((g): PermissionGrant => ({
        level: g.level,
        ...(g.appName && { appName: g.appName }),
        grantType: 'always',
        grantedAt: now,
      })),
      ...this.grants.filter((g) => !(g.grantType === 'timed' && g.expiresAt && g.expiresAt < now)),
    ]
  }

  /**
   * The app a session's last computer-use command acted in, if any: what its
   * activity indicator shows while the agent works, and what taking the app
   * back revokes. It holds nothing on the machine; each command names its own
   * target.
   */
  activeApp(sessionId: string): string | undefined {
    return this.activeApps.get(sessionId)
  }

  /** Record the app a session acted in; true when it differs from its last one. */
  setActiveApp(sessionId: string, appName: string): boolean {
    const changed = this.activeApps.get(sessionId) !== appName
    this.activeApps.set(sessionId, appName)
    return changed
  }

  /** Forget a session's active app, or every session's. */
  clearActiveApp(sessionId?: string): void {
    if (sessionId === undefined) this.activeApps.clear()
    else this.activeApps.delete(sessionId)
  }

  /** This agent's persisted "always" grants, read fresh from settings. */
  private async readPersisted(): Promise<readonly PersistedGrant[]> {
    try {
      return coversSomething((await getSettings()).computerUse?.agentPermissions?.[this.slug]?.grants ?? [])
    } catch (error) {
      console.error(`[ComputerUsePermissions] Failed to load grants for ${this.slug} from settings:`, error)
      return []
    }
  }

  /**
   * Rewrite this agent's persisted "always" grants from the stored ones: its
   * entry alone, written or removed, with every other agent's entry left as
   * it is. `update` runs inside a settings mutator (possibly more than once),
   * so it only computes the new list.
   */
  private async writePersisted(update: (grants: readonly PersistedGrant[]) => PersistedGrant[]): Promise<void> {
    try {
      // Compare-and-set write: preserves any concurrent settings change
      // instead of overwriting from a stale snapshot.
      await mutateSettings((settings) => {
        const agentPermissions = { ...settings.computerUse?.agentPermissions }
        const grants = update(coversSomething(agentPermissions[this.slug]?.grants ?? []))
        if (grants.length > 0) {
          agentPermissions[this.slug] = { grants }
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

  private grantMatches(
    grant: Pick<PermissionGrant, 'level' | 'appName'>,
    level: ComputerUsePermissionLevel,
    appName?: string,
  ): boolean {
    if (grant.level !== level) return false
    // For 'use_application', the named app must match: a request that names
    // no app is asked about every time, and no grant covers it.
    if (level === 'use_application') {
      return appName !== undefined && grant.appName === appName
    }
    return true
  }

  private removeMatchingGrants(level: ComputerUsePermissionLevel, appName?: string): void {
    this.grants = this.grants.filter((g) => !this.grantMatches(g, level, appName))
  }
}
