import { randomUUID } from 'crypto'
import { and, eq, gt, isNull, ne, or, count, getTableColumns } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { apnsDevices, mobileDevice } from '@shared/lib/db/schema'

export type ApnsDeviceRow = typeof apnsDevices.$inferSelect

/**
 * Ceiling on stored devices per owner. Real users have a handful of devices;
 * the cap exists so an authenticated caller can't grow the table (and the
 * per-notification send fan-out) without bound. Refreshing an existing token
 * never counts against it.
 */
export const MAX_APNS_DEVICES_PER_OWNER = 10

/**
 * Insert or refresh a device's APNs registration, keyed by the device token.
 * The app re-registers on every launch (APNs asks apps to treat the token as
 * ephemeral), so this doubles as the keep-alive that repairs a lost row.
 *
 * When the registration carries a `mobileDeviceId`, any other row for the same
 * physical device but a DIFFERENT token is deleted in the same transaction —
 * APNs rotates tokens across reinstalls/restores and the stale token would
 * otherwise linger until a send finally reports it Unregistered.
 *
 * Returns false when the owner is at MAX_APNS_DEVICES_PER_OWNER and the token
 * is new (the route surfaces this as 429).
 */
export function upsertApnsDevice(params: {
  token: string
  environment: string
  userId: string | null
  mobileDeviceId: string | null
  workspaceTag?: string | null
  deviceName?: string | null
  platform?: string
}): boolean {
  const now = new Date()
  return db.transaction((tx) => {
    if (params.mobileDeviceId !== null) {
      // One live token per physical device: drop rotated-away tokens.
      tx.delete(apnsDevices)
        .where(
          and(
            eq(apnsDevices.mobileDeviceId, params.mobileDeviceId),
            ne(apnsDevices.token, params.token)
          )
        )
        .run()
    }

    const exists = tx
      .select({ id: apnsDevices.id })
      .from(apnsDevices)
      .where(eq(apnsDevices.token, params.token))
      .limit(1)
      .all()

    if (exists.length === 0) {
      const ownerFilter =
        params.userId === null
          ? isNull(apnsDevices.userId)
          : eq(apnsDevices.userId, params.userId)
      const [{ ownerCount }] = tx
        .select({ ownerCount: count() })
        .from(apnsDevices)
        .where(ownerFilter)
        .all()
      if (ownerCount >= MAX_APNS_DEVICES_PER_OWNER) {
        return false
      }
    }

    tx.insert(apnsDevices)
      .values({
        id: randomUUID(),
        token: params.token,
        environment: params.environment,
        userId: params.userId,
        mobileDeviceId: params.mobileDeviceId,
        workspaceTag: params.workspaceTag ?? null,
        deviceName: params.deviceName ?? null,
        platform: params.platform ?? 'ios',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: apnsDevices.token,
        set: {
          environment: params.environment,
          userId: params.userId,
          mobileDeviceId: params.mobileDeviceId,
          workspaceTag: params.workspaceTag ?? null,
          deviceName: params.deviceName ?? null,
          platform: params.platform ?? 'ios',
          updatedAt: now,
        },
      })
      .run()
    return true
  })
}

export function listApnsDevices(): ApnsDeviceRow[] {
  return db.select().from(apnsDevices).all()
}

/**
 * Devices eligible for push DELIVERY: registrations whose paired mobile
 * device is still live. An expired pairing is hidden from the user's device
 * management UI — it must not keep receiving session metadata just because
 * APNs still accepts its token. Rows with no device link (defensive local-mode
 * parity with push_subscriptions) stay deliverable.
 */
export function listDeliverableApnsDevices(now: Date = new Date()): ApnsDeviceRow[] {
  return db
    .select(getTableColumns(apnsDevices))
    .from(apnsDevices)
    .leftJoin(mobileDevice, eq(apnsDevices.mobileDeviceId, mobileDevice.id))
    .where(or(isNull(apnsDevices.mobileDeviceId), gt(mobileDevice.expiresAt, now)))
    .all()
}

export function deleteApnsDeviceById(id: string): void {
  db.delete(apnsDevices).where(eq(apnsDevices.id, id)).run()
}

/**
 * Remove a device's registration. In auth mode the delete is scoped to the
 * owner (`ownerUserId`) so one user can't unregister another user's device by
 * guessing its token. Local mode (undefined) deletes by token alone: the
 * single local user owns every device, including rows created under a
 * previous auth-mode life of the same database — those must stay deletable.
 */
export function deleteApnsDeviceByToken(token: string, ownerUserId?: string): boolean {
  const ownerFilter =
    ownerUserId === undefined ? undefined : eq(apnsDevices.userId, ownerUserId)
  const result = db
    .delete(apnsDevices)
    .where(and(eq(apnsDevices.token, token), ownerFilter))
    .run()
  return result.changes > 0
}
