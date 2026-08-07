import webPush from 'web-push'
import { eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { pushSubscriptions, pushVapidKeys } from '@shared/lib/db/schema'

const VAPID_ROW_ID = 1

export interface VapidKeyPair {
  publicKey: string
  privateKey: string
}

export function getVapidKeys(): VapidKeyPair | null {
  const rows = db
    .select()
    .from(pushVapidKeys)
    .where(eq(pushVapidKeys.id, VAPID_ROW_ID))
    .limit(1)
    .all()
  if (rows.length === 0) {
    return null
  }
  return { publicKey: rows[0].publicKey, privateKey: rows[0].privateKey }
}

/**
 * Load the install's VAPID keypair, generating it on first use (i.e. the
 * first time a device asks to subscribe). Browsers bind subscriptions to the
 * public key, so the pair must never rotate silently — and conversely, if we
 * are minting a fresh pair while subscription rows somehow still exist (e.g.
 * a restored/partial backup), those rows are undeliverable and get dropped.
 */
export function getOrCreateVapidKeys(): VapidKeyPair {
  const existing = getVapidKeys()
  if (existing) {
    return existing
  }

  const generated = webPush.generateVAPIDKeys()
  db.transaction((tx) => {
    tx.delete(pushSubscriptions).run()
    tx.insert(pushVapidKeys)
      .values({
        id: VAPID_ROW_ID,
        publicKey: generated.publicKey,
        privateKey: generated.privateKey,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .run()
  })

  // Re-read instead of trusting `generated`: under a concurrent first-use
  // race the row that won the insert is the pair the subscriber was given.
  return getVapidKeys() ?? generated
}
