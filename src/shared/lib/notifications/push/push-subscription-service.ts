import { randomUUID } from 'crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { pushSubscriptions } from '@shared/lib/db/schema'

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect

/**
 * Insert or refresh a device's push subscription, keyed by endpoint. The
 * client re-upserts on every launch (declarative Web Push has no service
 * worker, hence no `pushsubscriptionchange` event), so this doubles as the
 * keep-alive that repairs a rotated endpoint or lost row.
 */
export function upsertPushSubscription(params: {
  endpoint: string
  p256dh: string
  auth: string
  origin: string
  userId: string | null
  deviceName?: string | null
}): void {
  const now = new Date()
  db.insert(pushSubscriptions)
    .values({
      id: randomUUID(),
      endpoint: params.endpoint,
      keysP256dh: params.p256dh,
      keysAuth: params.auth,
      origin: params.origin,
      userId: params.userId,
      deviceName: params.deviceName ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        keysP256dh: params.p256dh,
        keysAuth: params.auth,
        origin: params.origin,
        userId: params.userId,
        deviceName: params.deviceName ?? null,
        updatedAt: now,
      },
    })
    .run()
}

export function listPushSubscriptions(): PushSubscriptionRow[] {
  return db.select().from(pushSubscriptions).all()
}

export function deletePushSubscriptionById(id: string): void {
  db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run()
}

/**
 * Remove a device's subscription. In auth mode the delete is scoped to the
 * owner (`ownerUserId`) so one user can't unsubscribe another user's device
 * by guessing its endpoint. Local mode (undefined) deletes by endpoint alone:
 * the single local user owns every device, including rows created under a
 * previous auth-mode life of the same database — those must stay deletable.
 */
export function deletePushSubscriptionByEndpoint(
  endpoint: string,
  ownerUserId?: string
): boolean {
  const ownerFilter =
    ownerUserId === undefined ? undefined : eq(pushSubscriptions.userId, ownerUserId)
  const result = db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, endpoint), ownerFilter))
    .run()
  return result.changes > 0
}
