/**
 * Platform Notifications Manager
 *
 * Desktop-only background subscription that turns platform notification
 * INSERTs (Supabase Realtime, RLS-scoped to the connected user) into OS
 * notifications and inbox-invalidation signals. Holds NO content store — the
 * inbox always reads live from the platform proxy; this manager owns only the
 * websocket and an OS-notification dedup watermark.
 *
 * Non-auth only: a multi-tenant auth_mode server has no business firing OS
 * notifications; its web clients rely on the inbox query's refetch cadence.
 */

import { isAuthMode } from '@shared/lib/auth/mode'
import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import { messagePersister } from '@shared/lib/container/message-persister'
import { captureException } from '@shared/lib/error-reporting'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import {
  getNotificationsRealtimeConfig,
  listPlatformNotifications,
} from '@shared/lib/services/platform-notifications-client'
import { platformNotificationRealtimeRecordSchema } from '@shared/lib/services/platform-notifications-schema'
import { SupabaseRealtimeClient } from '@shared/lib/services/supabase-realtime-client'
import { getUserSettings } from '@shared/lib/services/user-settings-service'

// JWT lasts 1 hour; refresh with headroom. The same tick retries the
// subscription when the proxy returned a null config earlier (e.g. an auth
// cache entry that predates the userId claim).
const JWT_REFRESH_INTERVAL_MS = 50 * 60 * 1000

class PlatformNotificationsManager {
  private isRunning = false
  private realtimeClient: SupabaseRealtimeClient | null = null
  private refreshInterval: NodeJS.Timeout | null = null
  private notifiedIds = new Set<string>()
  private lastNotifiedAt: string | null = null
  // Bumped by every stop() and start(): an async connect that resumes after
  // its generation passed must not touch the current one's client/interval
  // (e.g. a quick platform disconnect→reconnect while the config mint is in
  // flight would otherwise resubscribe with the stale identity's JWT).
  private generation = 0

  async start(): Promise<void> {
    if (this.isRunning) return
    if (isAuthMode()) return
    if (!getPlatformProxyBaseUrl() || !getPlatformAccessToken()) {
      console.log('[PlatformNotifications] Platform not connected, skipping')
      return
    }

    this.isRunning = true
    const generation = ++this.generation
    console.log('[PlatformNotifications] Starting...')

    try {
      await this.connect(generation)
    } catch (error) {
      console.error('[PlatformNotifications] Initial connect failed:', error)
    }

    // The refresh interval retries a failed initial connect, so it installs
    // even when connect() threw — but never for a superseded generation.
    if (generation !== this.generation || !this.isRunning) return
    this.refreshInterval = setInterval(() => {
      void this.refreshOrReconnect()
    }, JWT_REFRESH_INTERVAL_MS)
  }

  stop(): void {
    if (!this.isRunning) return
    this.isRunning = false
    this.generation++

    if (this.realtimeClient) {
      this.realtimeClient.disconnect()
      this.realtimeClient = null
    }
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = null
    }
    this.notifiedIds.clear()
    // The in-memory watermark re-seeds from settings on the next start; the
    // persisted value survives disconnect/reconnect (and process restarts).
    this.lastNotifiedAt = null
    console.log('[PlatformNotifications] Stopped')
  }

  isActive(): boolean {
    return this.isRunning
  }

  isRealtimeActive(): boolean {
    return this.realtimeClient?.isActive() ?? false
  }

  // Org JWTs need the acting member appended to the bearer; opaque personal
  // keys ignore it, so a placeholder is fine when no member is recorded.
  private getMemberId(): string {
    return getSettings().platformAuth?.memberId ?? 'local'
  }

  private async connect(generation: number): Promise<void> {
    const memberId = this.getMemberId()
    const config = await getNotificationsRealtimeConfig(memberId)
    if (generation !== this.generation) return
    if (!config) {
      // No acting-user context on the proxy yet — the refresh tick retries.
      console.log('[PlatformNotifications] Realtime config unavailable, will retry')
      return
    }

    await this.seedWatermark(memberId)

    if (generation !== this.generation || !this.isRunning) return
    if (this.realtimeClient) {
      this.realtimeClient.disconnect()
    }
    const client = new SupabaseRealtimeClient()
    this.realtimeClient = client
    await client.connect(config, (record) => {
      this.handleRealtimeInsert(record)
    })
    if (generation !== this.generation) {
      // Superseded while the socket opened: tear down our own client, but
      // leave this.realtimeClient alone if a newer connect already replaced it.
      client.disconnect()
      return
    }
    console.log('[PlatformNotifications] Realtime subscription active')
  }

  /**
   * The OS notification only ever fires from live INSERTs, so the watermark
   * exists to suppress replays/backdated inserts — never to replay a backlog.
   * Prefer the persisted value (survives restarts); seed a fresh install from
   * the newest existing row so pre-existing notifications can't fire.
   */
  private async seedWatermark(memberId: string): Promise<void> {
    if (this.lastNotifiedAt) return

    const persisted = getSettings().platformNotifications?.lastNotifiedAt
    if (persisted) {
      this.lastNotifiedAt = persisted
      return
    }

    try {
      const list = await listPlatformNotifications({ limit: 1 }, memberId)
      this.lastNotifiedAt = list.notifications[0]?.created_at ?? new Date(0).toISOString()
    } catch (error) {
      // Fail toward "notify nothing older than now" — an inbox read failure
      // must not turn the next reconnect into a notification storm.
      console.error('[PlatformNotifications] Watermark seed failed:', error)
      this.lastNotifiedAt = new Date().toISOString()
    }
    this.persistWatermark()
  }

  private persistWatermark(): void {
    const lastNotifiedAt = this.lastNotifiedAt
    if (!lastNotifiedAt) return
    try {
      mutateSettings((settings) => {
        settings.platformNotifications = { ...settings.platformNotifications, lastNotifiedAt }
      })
    } catch (error) {
      captureException(error, {
        tags: { area: 'platform-notifications', op: 'persist-watermark' },
      })
    }
  }

  private handleRealtimeInsert(rawRecord: unknown): void {
    const parsed = platformNotificationRealtimeRecordSchema.safeParse(rawRecord)
    if (!parsed.success) {
      captureException(parsed.error, {
        level: 'warning',
        tags: { area: 'platform-notifications', op: 'record-parse' },
      })
      return
    }
    const record = parsed.data

    // An open inbox page updates live regardless of OS-notification dedup.
    messagePersister.broadcastGlobal({ type: 'platform_notifications_changed' })

    // Dedup: the in-session id-set survives reconnect replays; the persisted
    // watermark survives restarts and suppresses backdated inserts.
    if (this.notifiedIds.has(record.id)) return
    if (this.lastNotifiedAt && record.created_at <= this.lastNotifiedAt) return
    this.notifiedIds.add(record.id)
    this.lastNotifiedAt =
      this.lastNotifiedAt && this.lastNotifiedAt > record.created_at
        ? this.lastNotifiedAt
        : record.created_at
    this.persistWatermark()

    if (!this.isPlatformNotificationEnabled()) return

    // Fire straight from the record (notifications are plain data, not a
    // claimable work queue — no re-poll). No agentSlug/sessionId: clicking
    // opens the notification detail route instead of a session.
    messagePersister.broadcastGlobal({
      type: 'os_notification',
      notificationType: 'platform_notification',
      platformNotificationId: record.id,
      title: record.title,
      body: record.body,
      actionContext: {
        kind: 'platform_notification',
        platformNotificationId: record.id,
      },
    })
  }

  // Manager runs non-auth only, so the single 'local' user's settings apply.
  // The renderer re-checks its own settings before showing the popup; this
  // gate just avoids broadcasting an event nobody may show.
  private isPlatformNotificationEnabled(): boolean {
    try {
      const notifications = getUserSettings('local').notifications
      if (!notifications.enabled) return false
      return notifications.platformNotification !== false
    } catch {
      return true
    }
  }

  /** 50-minute tick: refresh the Realtime JWT, or (re)connect if inactive. */
  private async refreshOrReconnect(): Promise<void> {
    if (!this.isRunning) return
    const generation = this.generation
    try {
      if (!this.realtimeClient?.isActive()) {
        await this.connect(generation)
        return
      }
      const config = await getNotificationsRealtimeConfig(this.getMemberId())
      if (config?.jwt && this.realtimeClient) {
        await this.realtimeClient.updateToken(config.jwt)
      }
    } catch (error) {
      console.error('[PlatformNotifications] JWT refresh failed:', error)
    }
  }
}

// Export singleton instance (persists across hot reloads)
const globalForManager = globalThis as unknown as {
  platformNotificationsManager: PlatformNotificationsManager | undefined
}

export const platformNotificationsManager =
  globalForManager.platformNotificationsManager ?? new PlatformNotificationsManager()

if (process.env.NODE_ENV !== 'production') {
  globalForManager.platformNotificationsManager = platformNotificationsManager
}
