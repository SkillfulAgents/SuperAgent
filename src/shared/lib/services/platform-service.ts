import { isAuthMode } from '@shared/lib/auth/mode'
import { captureException } from '@shared/lib/error-reporting'
import { background } from '@shared/lib/background'
import { PassTask, taskManager } from '@shared/lib/background-work'
import {
  getPlatformAuthStatus,
  refreshStoredPlatformAccount,
} from '@shared/lib/services/platform-auth-service'
import {
  fetchPlatformBillingInfo,
} from '@shared/lib/services/platform-billing-service'
import { refreshCloudWorkspace } from '@shared/lib/services/cloud-workspace-service'
import type { ParsedPlatformBillingInfo } from '@shared/lib/types/skillset-schema'
import { platformPlanCache } from '@shared/lib/llm-provider/platform-plan-cache'
import { actingPlanCacheKey } from '@shared/lib/llm-provider/platform-plan-account'
import { billingPlanPolicy } from '@shared/lib/llm-provider/platform-plan-policy'

/**
 * Boot-time service that keeps the connected platform account's info + billing
 * fresh. No-op when the platform isn't connected. Account/billing are
 * event-driven — refreshed on boot and on connect; the Account tab refreshes
 * billing on view and via a manual button (through the GET /api/platform-billing
 * route, which calls `refreshBilling()`). The cloud-workspace deployment token
 * additionally runs on a low-frequency background poll so it stays valid on a
 * long-lived app even without an Account-tab visit.
 *
 * The billing cache is **non-auth only** (single user). In auth_mode billing is
 * per-user and served live per request; caching it in this shared singleton
 * would leak one user's seat balance to another.
 */
class PlatformService {
  private isRunning = false
  private isProcessing = false
  private startupDelayMs = 10_000
  // Cloud-workspace token upkeep runs on a low-frequency poll (well under the
  // token's lifetime + 1h re-mint buffer) so an app left open past expiry still
  // holds a valid deployment token without needing an Account-tab visit.
  private cloudWorkspaceIntervalMs = 30 * 60_000
  private cachedBilling: ParsedPlatformBillingInfo | null = null
  private lastRefreshedAt: string | null = null
  // refresh() is self-guarding (no-op when disconnected) and never rejects.
  private readonly refreshTask = new PassTask('platform.refresh', () => this.refresh())
  // Self-gates (Electron + connected) and never throws.
  private readonly cloudWorkspaceTask = new PassTask('platform.cloud-workspace', () => refreshCloudWorkspace())
  readonly tasks = [this.refreshTask, this.cloudWorkspaceTask]

  start(): void {
    if (this.isRunning) return
    this.isRunning = true
    // Defer the first refresh so we don't compete with the rest of boot.
    background(taskManager().at(Date.now() + this.startupDelayMs, this.refreshTask.type, this.refreshTask.spec), { name: 'platform-service.schedule-refresh' })
    // Keep the cloud-workspace deployment token fresh even when the app is left
    // running and the Account tab is never opened.
    background(taskManager().ensureEvery(this.cloudWorkspaceTask.type, this.cloudWorkspaceTask.spec, { intervalMs: this.cloudWorkspaceIntervalMs }), { name: 'platform-service.schedule-cloud-workspace' })
    // Positive start signal — every service launched by startup.ts logs one
    // so a silent-dead service is distinguishable from a healthy idle one.
    console.log(`[PlatformService] Started (first refresh in ${Math.round(this.startupDelayMs / 1000)}s)`)
  }

  stop(): void {
    background(taskManager().cancel(this.refreshTask.type), { name: 'platform-service.cancel-refresh' })
    background(taskManager().cancel(this.cloudWorkspaceTask.type), { name: 'platform-service.cancel-cloud-workspace' })
    this.isRunning = false
  }

  /** Connect → refresh; disconnect → clear the cache. Either way the account changed. */
  async onAuthChanged(connected: boolean): Promise<void> {
    if (!connected) this.clearCache()
    // Before the refresh, so what the refresh reads is not forgotten with the rest.
    await platformPlanCache.clear()
    if (connected) background(this.refresh(), { name: 'platform-service.refresh-snapshot' })
  }

  /** Last warmed billing snapshot (non-auth only); null otherwise. */
  getCachedBilling(): ParsedPlatformBillingInfo | null {
    return this.cachedBilling
  }

  getLastRefreshedAt(): string | null {
    return this.lastRefreshedAt
  }

  clearCache(): void {
    this.cachedBilling = null
    this.lastRefreshedAt = null
  }

  /**
   * Fetch billing from the platform. When called inside a request scope the
   * fetch interceptor attributes the bearer to the acting member; at boot it
   * uses the stored/env token. Caches the result only in non-auth mode.
   */
  async refreshBilling(): Promise<ParsedPlatformBillingInfo> {
    // Taken before the request: a connection switched during it must not get
    // this account's policy.
    const actingKey = await actingPlanCacheKey()
    const planRead = await platformPlanCache.beginRead()
    const billing = await fetchPlatformBillingInfo()
    if (!isAuthMode()) {
      this.cachedBilling = billing
      this.lastRefreshedAt = new Date().toISOString()
    }
    // The snapshot carries the acting account's plan policy too: a billing
    // view after an upgrade unlocks models without waiting for the cache.
    const policy = billingPlanPolicy(billing)
    if (policy) await platformPlanCache.remember(actingKey, policy, planRead)
    return billing
  }

  /**
   * Boot/connect refresh: account identity → settings (when changed) + billing
   * warm-up. Fully defensive — billing is non-critical UI data, so this never
   * throws or rejects regardless of platform/settings glitches.
   */
  async refresh(): Promise<void> {
    try {
      if (this.isProcessing) return
      // Claimed before the auth read, so a second refresh() cannot slip in
      // while it is in flight.
      this.isProcessing = true
      try {
        if (!(await getPlatformAuthStatus()).connected) {
          this.clearCache()
          return
        }
        await refreshStoredPlatformAccount().catch((error) =>
          captureException(error, { tags: { area: 'platform-service', op: 'refresh-account' } }),
        )
        await this.refreshBilling().catch((error) =>
          captureException(error, { tags: { area: 'platform-service', op: 'refresh-billing' } }),
        )
        // Desktop-only (self-gates off Electron): keep the cloud-workspace
        // deployment token maintained on boot + connect. Never throws.
        await refreshCloudWorkspace()
      } finally {
        this.isProcessing = false
      }
    } catch (error) {
      captureException(error, { tags: { area: 'platform-service', op: 'refresh' } })
    }
  }
}

// Singleton that survives dev-server hot reloads (matches accountSyncService).
const globalForPlatform = globalThis as unknown as { __platformService?: PlatformService }
export const platformService = globalForPlatform.__platformService ?? new PlatformService()
if (process.env.NODE_ENV !== 'production') {
  globalForPlatform.__platformService = platformService
}
