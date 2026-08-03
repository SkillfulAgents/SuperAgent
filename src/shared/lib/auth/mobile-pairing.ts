import crypto from 'node:crypto'
import { and, asc, eq, gt, lt } from 'drizzle-orm'
import { captureException } from '@shared/lib/error-reporting'
import { db } from '@shared/lib/db'
import { authSession, mobileDevice, mobilePairingToken } from '@shared/lib/db/schema'
import { DEFAULT_AUTH_SETTINGS, getSettings } from '@shared/lib/config/settings'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import {
  InstalledClientSessionError,
  mintInstalledClientSession,
} from './installed-client-session'
import {
  MAX_DEVICE_NAME_LENGTH,
  MAX_OUTSTANDING_PAIRING_TOKENS,
  MOBILE_REFRESH_TOKEN_PREFIX,
  PAIRING_TOKEN_PREFIX,
  PAIRING_TOKEN_TTL_MS,
  type MobileSessionResponse,
} from './mobile-pairing-schema'

/** Generic denial for pairing and refresh grants. */
export class MobilePairingError extends Error {
  constructor(description?: string) {
    super(description ?? 'invalid_mobile_grant')
    this.name = 'MobilePairingError'
  }
}

export interface MobilePairingRequestMeta {
  deviceName?: string
  platform?: string
  userAgent?: string
  ipAddress?: string
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/** Trimmed, capped user-visible label — or undefined when nothing usable. */
function normalizeDeviceName(deviceName?: string): string | undefined {
  const trimmed = deviceName?.trim().slice(0, MAX_DEVICE_NAME_LENGTH)
  return trimmed || undefined
}

function normalizePlatform(platform?: string): string | undefined {
  const trimmed = platform?.trim().slice(0, 64)
  return trimmed || undefined
}

function mobileDeviceLifetimeMs(): number {
  const settings = getSettings()
  const auth = { ...DEFAULT_AUTH_SETTINGS, ...settings.auth }
  const configuredDays = auth.mobileDeviceLifetimeDays ?? 90
  const days = Number.isFinite(configuredDays) && configuredDays > 0 ? configuredDays : 90
  return days * 24 * 60 * 60 * 1000
}

function newRefreshToken(): string {
  return MOBILE_REFRESH_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url')
}

/** Opportunistic TTL cleanup keeps the one-time grant table bounded. */
function sweepExpiredPairingTokens(): void {
  db.delete(mobilePairingToken).where(lt(mobilePairingToken.expiresAt, new Date())).run()
}

/**
 * Mint a short-lived, single-use authorization grant for `userId`. Plaintext is
 * returned exactly once; only its SHA-256 hash is stored.
 */
export function mintPairingToken(userId: string): { token: string; expiresAt: Date } {
  sweepExpiredPairingTokens()

  const outstanding = db
    .select({ tokenHash: mobilePairingToken.tokenHash })
    .from(mobilePairingToken)
    .where(eq(mobilePairingToken.userId, userId))
    .orderBy(asc(mobilePairingToken.createdAt))
    .all()
  const excess = outstanding.length - (MAX_OUTSTANDING_PAIRING_TOKENS - 1)
  for (const row of excess > 0 ? outstanding.slice(0, excess) : []) {
    db.delete(mobilePairingToken).where(eq(mobilePairingToken.tokenHash, row.tokenHash)).run()
  }

  const token = PAIRING_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url')
  const now = new Date()
  const expiresAt = new Date(now.getTime() + PAIRING_TOKEN_TTL_MS)
  db.insert(mobilePairingToken)
    .values({ tokenHash: sha256Hex(token), userId, createdAt: now, expiresAt })
    .run()
  return { token, expiresAt }
}

type IssuedInstalledSession = Awaited<ReturnType<typeof mintInstalledClientSession>>

async function mintMobileAccessSession(
  userId: string,
  deviceId: string,
  meta: MobilePairingRequestMeta,
): Promise<IssuedInstalledSession> {
  try {
    return await mintInstalledClientSession({
      userId,
      method: 'mobile',
      deviceId,
      meta,
    })
  } catch (error) {
    if (error instanceof InstalledClientSessionError) throw new MobilePairingError()
    throw error
  }
}

function mobileSessionResponse(
  issued: IssuedInstalledSession,
  deviceId: string,
  refreshToken: string,
  refreshExpiresAt: Date,
): MobileSessionResponse {
  return {
    token: issued.session.token,
    expiresAt: new Date(issued.session.expiresAt).toISOString(),
    refreshToken,
    refreshExpiresAt: refreshExpiresAt.toISOString(),
    deviceId,
    user: {
      id: issued.user.id,
      email: issued.user.email,
      name: issued.user.name,
    },
  }
}

/**
 * Redeem a pairing grant into a stable device plus a normal Better Auth access
 * session. The device owns a separately rotated refresh credential; the access
 * session deliberately uses the same lifetime policy as desktop token exchange.
 */
export async function redeemPairingToken(
  token: string,
  meta: MobilePairingRequestMeta = {},
): Promise<MobileSessionResponse> {
  let row: { userId: string; expiresAt: Date } | undefined
  try {
    row = db
      .delete(mobilePairingToken)
      .where(eq(mobilePairingToken.tokenHash, sha256Hex(token)))
      .returning({ userId: mobilePairingToken.userId, expiresAt: mobilePairingToken.expiresAt })
      .get()
  } catch (error) {
    captureException(error, { tags: { component: 'mobile-pairing', operation: 'token-consume' } })
    throw new MobilePairingError()
  }
  if (!row || new Date(row.expiresAt).getTime() <= Date.now()) {
    throw new MobilePairingError()
  }

  const deviceId = crypto.randomUUID()
  const refreshToken = newRefreshToken()
  const now = new Date()
  const refreshExpiresAt = new Date(now.getTime() + mobileDeviceLifetimeMs())
  db.insert(mobileDevice)
    .values({
      id: deviceId,
      userId: row.userId,
      refreshTokenHash: sha256Hex(refreshToken),
      deviceName: normalizeDeviceName(meta.deviceName),
      platform: normalizePlatform(meta.platform),
      createdAt: now,
      updatedAt: now,
      expiresAt: refreshExpiresAt,
    })
    .run()

  try {
    const issued = await mintMobileAccessSession(row.userId, deviceId, meta)
    return mobileSessionResponse(issued, deviceId, refreshToken, refreshExpiresAt)
  } catch (error) {
    // Device creation and access-session issuance are one logical operation.
    // Deleting the device also removes any partially created family sessions.
    db.delete(authSession).where(eq(authSession.deviceId, deviceId)).run()
    db.delete(mobileDevice).where(eq(mobileDevice.id, deviceId)).run()
    throw error
  }
}

/**
 * Rotate a device refresh credential exactly once and replace its access
 * session. The compare-and-swap on the old hash is the replay/concurrency gate:
 * only one caller can win, and the losing request never leaves a live session.
 */
export async function renewMobileSession(
  refreshToken: string,
  meta: MobilePairingRequestMeta = {},
): Promise<MobileSessionResponse> {
  const oldHash = sha256Hex(refreshToken)
  const now = new Date()
  const device = db
    .select()
    .from(mobileDevice)
    .where(and(eq(mobileDevice.refreshTokenHash, oldHash), gt(mobileDevice.expiresAt, now)))
    .get()
  if (!device) throw new MobilePairingError('invalid_refresh_token')

  const rotatedToken = newRefreshToken()
  const rotatedHash = sha256Hex(rotatedToken)
  const refreshExpiresAt = new Date(now.getTime() + mobileDeviceLifetimeMs())
  const deviceName = normalizeDeviceName(meta.deviceName) ?? device.deviceName ?? undefined

  const rotated = db
    .update(mobileDevice)
    .set({
      refreshTokenHash: rotatedHash,
      deviceName,
      updatedAt: now,
      expiresAt: refreshExpiresAt,
    })
    .where(
      and(
        eq(mobileDevice.id, device.id),
        eq(mobileDevice.refreshTokenHash, oldHash),
        gt(mobileDevice.expiresAt, now),
      ),
    )
    .run()
  if (rotated.changes !== 1) throw new MobilePairingError('invalid_refresh_token')

  try {
    // The CAS above elected one rotation winner, so it is now safe to remove
    // the previous access token before minting its replacement.
    db.delete(authSession).where(eq(authSession.deviceId, device.id)).run()
    const issued = await mintMobileAccessSession(device.userId, device.id, {
      ...meta,
      deviceName,
      platform: device.platform ?? undefined,
    })
    return mobileSessionResponse(issued, device.id, rotatedToken, refreshExpiresAt)
  } catch (error) {
    // The new secret has not left this process. Restore the old grant so a
    // transient session-mint failure is retryable rather than unpairing the app.
    db.update(mobileDevice)
      .set({
        refreshTokenHash: oldHash,
        deviceName: device.deviceName,
        updatedAt: device.updatedAt,
        expiresAt: device.expiresAt,
      })
      .where(and(eq(mobileDevice.id, device.id), eq(mobileDevice.refreshTokenHash, rotatedHash)))
      .run()
    throw error
  }
}

export interface MobileDevice {
  id: string
  deviceName: string | null
  platform: string | null
  createdAt: Date
  updatedAt: Date
  expiresAt: Date
}

/** One row per physical paired device; expired refresh grants are not paired. */
export function listMobileDevices(userId: string): MobileDevice[] {
  return db
    .select({
      id: mobileDevice.id,
      deviceName: mobileDevice.deviceName,
      platform: mobileDevice.platform,
      createdAt: mobileDevice.createdAt,
      updatedAt: mobileDevice.updatedAt,
      expiresAt: mobileDevice.expiresAt,
    })
    .from(mobileDevice)
    .where(and(eq(mobileDevice.userId, userId), gt(mobileDevice.expiresAt, new Date())))
    .orderBy(asc(mobileDevice.createdAt))
    .all()
}

/** Revoke an entire mobile device family, including every access session. */
export async function revokeMobileDevice(userId: string, deviceId: string): Promise<boolean> {
  const deleted = db.transaction((tx) => {
    const owned = tx
      .select({ id: mobileDevice.id })
      .from(mobileDevice)
      .where(and(eq(mobileDevice.id, deviceId), eq(mobileDevice.userId, userId)))
      .get()
    if (!owned) return false
    // Explicit deletion keeps revocation correct even on SQLite builds that do
    // not enforce foreign-key cascades, while the schema FK remains the backstop.
    tx.delete(authSession).where(eq(authSession.deviceId, deviceId)).run()
    tx.delete(mobileDevice).where(eq(mobileDevice.id, deviceId)).run()
    return true
  })
  if (!deleted) return false

  await logAuditEvent({
    userId,
    object: 'session',
    objectId: deviceId,
    action: 'revoked',
    details: { method: 'mobile', scope: 'device-family' },
  })
  return true
}
