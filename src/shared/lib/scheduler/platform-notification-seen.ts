import { z } from 'zod'
import { appState, defineNamespace, type AppState } from '@shared/lib/app-state'

/**
 * How long a platform notification's seen marker lasts. It only has to
 * outlive the window in which the same INSERT can reach a receiver twice:
 * every process holding a realtime connection gets the row within seconds of
 * the insert, and a reconnect (at the latest on the 50-minute refresh tick)
 * is the only path for a replay. A day is far past both. After a marker
 * expires, the persisted watermark (settings) still suppresses any row not
 * newer than the newest one notified, so expiry reopens no replay; the day
 * only bounds how many markers are kept.
 */
export const PLATFORM_NOTIFICATION_SEEN_TTL_MS = 24 * 60 * 60 * 1000

const seenPlatformNotifications = defineNamespace({
  name: 'platform-notify:seen',
  consistency: 'strong',
  schema: z.literal(true),
  expiry: { ttlMs: PLATFORM_NOTIFICATION_SEEN_TTL_MS, onUpdate: 'keep' },
})

/**
 * Claims the OS broadcast of one platform notification for this receiver.
 * Of every receiver that gets the same row (other processes, a replay), the
 * first claim wins and the rest get false: the claim is one atomic insert.
 * `state` is this process's AppState; a test passes another process's.
 */
export async function claimPlatformNotificationBroadcast(
  memberId: string,
  notificationId: string,
  state: AppState = appState(),
): Promise<boolean> {
  const claim = await state.insertIfAbsent(seenPlatformNotifications.key(memberId, notificationId), true)
  return claim.inserted
}
