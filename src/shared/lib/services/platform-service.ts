import { isAuthMode } from '@shared/lib/auth/mode'
import { captureException } from '@shared/lib/error-reporting'
import {
  getPlatformAuthStatus,
  refreshStoredPlatformAccount,
} from '@shared/lib/services/platform-auth-service'
import {
  fetchPlatformBillingInfo,
} from '@shared/lib/services/platform-billing-service'
import type { ParsedPlatformBillingInfo } from '@shared/lib/types/skillset-schema'

/**
 * Boot-time service that keeps the connected platform account's info + billing
 * fresh. No-op when the platform isn't connected. Event-driven (no background
 * poll): it refreshes on boot and on connect; the Account tab refreshes billing
 * on view and via a manual button (through the GET /api/platform-billing route,
 * which calls `refreshBilling()`).
 *
 * The billing cache is **non-auth only** (single user). In auth_mode billing is
 * per-user and served live per request; caching it in this shared singleton
 * would leak one user's seat balance to another.
 */
class PlatformService {
  private startupTimeoutId: ReturnType<typeof setTimeout> | null = null
  private isRunning = false
  private isProcessing = false
  private startupDelayMs = 10_000
  private cachedBilling: ParsedPlatformBillingInfo | null = null
  private lastRefreshedAt: string | null = null

  start(): void {
    if (this.isRunning) return
    this.isRunning = true
    // Defer the first refresh so we don't compete with the rest of boot.
    // refresh() is self-guarding (no-op when disconnected) and never rejects.
    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null
      void this.refresh()
    }, this.startupDelayMs)
    // Positive start signal — every service launched by startup.ts logs one
    // so a silent-dead service is distinguishable from a healthy idle one.
    console.log(`[PlatformService] Started (first refresh in ${Math.round(this.startupDelayMs / 1000)}s)`)
  }

  stop(): void {
    if (this.startupTimeoutId) {
      clearTimeout(this.startupTimeoutId)
      this.startupTimeoutId = null
    }
    this.isRunning = false
  }

  /** Connect → refresh; disconnect → clear the cache. */
  onAuthChanged(connected: boolean): void {
    if (connected) void this.refresh()
    else this.clearCache()
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
    const billing = await fetchPlatformBillingInfo()
    if (!isAuthMode()) {
      this.cachedBilling = billing
      this.lastRefreshedAt = new Date().toISOString()
    }
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
      if (!getPlatformAuthStatus().connected) {
        this.clearCache()
        return
      }
      this.isProcessing = true
      try {
        await refreshStoredPlatformAccount().catch((error) =>
          captureException(error, { tags: { area: 'platform-service', op: 'refresh-account' } }),
        )
        await this.refreshBilling().catch((error) =>
          captureException(error, { tags: { area: 'platform-service', op: 'refresh-billing' } }),
        )
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
