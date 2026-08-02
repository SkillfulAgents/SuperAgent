import crypto from 'node:crypto'
import { and, asc, eq, lt } from 'drizzle-orm'
import { captureException } from '@shared/lib/error-reporting'
import { db } from '@shared/lib/db'
import { authSession, mobilePairingToken } from '@shared/lib/db/schema'
import { DEFAULT_AUTH_SETTINGS, getSettings } from '@shared/lib/config/settings'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { getAuth } from './index'
import { withSessionAuditContext } from './session-audit'
import {
  MAX_DEVICE_NAME_LENGTH,
  MAX_OUTSTANDING_PAIRING_TOKENS,
  PAIRING_TOKEN_PREFIX,
  PAIRING_TOKEN_TTL_MS,
  SUPERSEDE_GRACE_MS,
  type MobileSessionResponse,
  type RenewPurpose,
} from './mobile-pairing-schema'

/**
 * Denial for the pairing endpoints. The message is deliberately generic: a
 * missing, expired, and already-redeemed token must be indistinguishable to
 * the caller, so nothing here may disclose which case was hit.
 */
export class MobilePairingError extends Error {
  constructor(description?: string) {
    super(description ?? 'invalid_pairing_token')
    this.name = 'MobilePairingError'
  }
}

export interface MobilePairingRequestMeta {
  deviceName?: string
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

function mobileSessionLifetimeMs(): number {
  const settings = getSettings()
  const auth = { ...DEFAULT_AUTH_SETTINGS, ...settings.auth }
  return (auth.mobileSessionLifetimeDays ?? 90) * 24 * 60 * 60 * 1000
}

/** Opportunistic TTL cleanup keeps the table bounded. */
function sweepExpiredPairingTokens(): void {
  db.delete(mobilePairingToken).where(lt(mobilePairingToken.expiresAt, new Date())).run()
}

/**
 * Mint a single-use pairing token for `userId`.
 *
 * The plaintext (`mp_` + 32 random bytes base64url) is returned to the caller
 * exactly once and never stored — only its sha256 hex lands in the database.
 * A user holds at most MAX_OUTSTANDING_PAIRING_TOKENS un-redeemed tokens;
 * minting past the cap deletes the oldest first.
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

type AuthContext = Awaited<ReturnType<typeof getAuth>['$context']>

/**
 * Banned/pending enforcement, mirrored from token-exchange.ts: the admin
 * plugin's session.create.before hook only runs inside an endpoint context, so
 * a session minted through the internal adapter must enforce it explicitly —
 * including the pending-approval ban applied on signup. Mirrors the plugin's
 * banExpires auto-unban.
 */
async function assertUserMayHoldSession(ctx: AuthContext, userId: string) {
  const fresh = await ctx.internalAdapter.findUserById(userId)
  if (!fresh) {
    // Invariant violation: the pairing row / session referenced this user.
    // Masked to the client as a generic denial, but a systemic occurrence must
    // be visible.
    captureException(new Error('mobile pairing: user missing at session mint'), {
      tags: { component: 'mobile-pairing', operation: 'user-missing' },
      extra: { userId },
    })
    throw new MobilePairingError()
  }
  const banned = fresh as typeof fresh & { banned?: boolean | null; banExpires?: Date | null }
  if (banned.banned) {
    if (banned.banExpires && new Date(banned.banExpires).getTime() < Date.now()) {
      await ctx.internalAdapter.updateUser(fresh.id, {
        banned: false,
        banReason: null,
        banExpires: null,
      })
    } else {
      throw new MobilePairingError()
    }
  }
  return fresh
}

/**
 * Mint a fixed-lifetime mobile session for `userId` through the internal
 * adapter, tagged `mobile` for the audit trail and the paired-devices list.
 *
 * The 4th `createSession` argument (`overrideAll: true`) is required: without
 * it the adapter's own `expiresAt` (interactive session lifetime) wins over
 * the override (verified against better-auth 1.6.23).
 */
async function mintMobileSession(
  ctx: AuthContext,
  userId: string,
  meta: MobilePairingRequestMeta,
): Promise<MobileSessionResponse> {
  const user = await assertUserMayHoldSession(ctx, userId)

  const expiresAt = new Date(Date.now() + mobileSessionLifetimeMs())
  const session = await withSessionAuditContext({ method: 'mobile' }, () =>
    ctx.internalAdapter.createSession(
      user.id,
      false,
      {
        expiresAt,
        deviceName: normalizeDeviceName(meta.deviceName),
        userAgent: meta.userAgent?.slice(0, 512) || 'mobile',
        ipAddress: meta.ipAddress ?? '',
      },
      true,
    ),
  )
  if (!session) {
    captureException(new Error('mobile pairing: session creation returned no session'), {
      tags: { component: 'mobile-pairing', operation: 'session-create' },
      extra: { userId: user.id },
    })
    throw new MobilePairingError()
  }

  return {
    token: session.token,
    expiresAt: new Date(session.expiresAt).toISOString(),
    user: { id: user.id, email: user.email, name: user.name },
  }
}

/**
 * Redeem a pairing token for a mobile session.
 *
 * Single-use is atomic: `DELETE … WHERE token_hash = … RETURNING` — only the
 * request whose delete returns the row may mint a session, so a replayed or
 * concurrent redemption loses cleanly. Expiry is checked on the returned row,
 * and every failure surfaces as the same generic {@link MobilePairingError}.
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
    // Reaching here means the pairing table itself is failing — report it
    // (never the token value), deny the client generically.
    captureException(error, { tags: { component: 'mobile-pairing', operation: 'token-consume' } })
    throw new MobilePairingError()
  }
  if (!row || new Date(row.expiresAt).getTime() <= Date.now()) {
    throw new MobilePairingError()
  }

  const auth = getAuth()
  const ctx = await auth.$context
  return mintMobileSession(ctx, row.userId, meta)
}

export interface MobileSessionForRenewal {
  id: string
  userId: string
  expiresAt: Date
  deviceName?: string | null
}

/**
 * Mint a fresh fixed-lifetime mobile session for the caller's user.
 *
 * `purpose: 'renew'` (default) supersedes the calling session with a grace
 * window: the old row's expiry is clamped to at most now + SUPERSEDE_GRACE_MS
 * (never extended), so an app that fails to persist the new token keeps
 * working long enough to retry. `purpose: 'additional-device'` leaves the
 * caller's session untouched.
 */
export async function renewMobileSession(
  session: MobileSessionForRenewal,
  meta: MobilePairingRequestMeta & { purpose?: RenewPurpose } = {},
): Promise<MobileSessionResponse> {
  const auth = getAuth()
  const ctx = await auth.$context
  const minted = await mintMobileSession(ctx, session.userId, {
    ...meta,
    // A renewal without a new name keeps the device's existing label.
    deviceName: meta.deviceName ?? session.deviceName ?? undefined,
  })

  if ((meta.purpose ?? 'renew') === 'renew') {
    const graceEnd = new Date(Date.now() + SUPERSEDE_GRACE_MS)
    const currentExpiry = new Date(session.expiresAt)
    if (currentExpiry.getTime() > graceEnd.getTime()) {
      db.update(authSession)
        .set({ expiresAt: graceEnd })
        .where(eq(authSession.id, session.id))
        .run()
    }
  }

  return minted
}

export interface MobileDevice {
  id: string
  deviceName: string | null
  createdAt: Date
  updatedAt: Date
  expiresAt: Date
}

/**
 * The user's mobile-paired sessions, for the paired-devices list. Ids, labels
 * and timestamps only — token values never leave the database.
 */
export function listMobileDevices(userId: string): MobileDevice[] {
  return db
    .select({
      id: authSession.id,
      deviceName: authSession.deviceName,
      createdAt: authSession.createdAt,
      updatedAt: authSession.updatedAt,
      expiresAt: authSession.expiresAt,
    })
    .from(authSession)
    .where(and(eq(authSession.userId, userId), eq(authSession.creationMethod, 'mobile')))
    .orderBy(asc(authSession.createdAt))
    .all()
}

/**
 * Revoke one of the user's mobile-paired sessions by deleting its row (the
 * same mechanism the concurrent-session reaper uses — the bearer token dies
 * with the row). Scoped to the caller's own `creationMethod = 'mobile'` rows;
 * anything else reports not-found. Records a `session:revoked` audit event.
 */
export async function revokeMobileDevice(userId: string, sessionId: string): Promise<boolean> {
  const deleted = db
    .delete(authSession)
    .where(
      and(
        eq(authSession.id, sessionId),
        eq(authSession.userId, userId),
        eq(authSession.creationMethod, 'mobile'),
      ),
    )
    .returning({ id: authSession.id })
    .get()
  if (!deleted) return false

  await logAuditEvent({
    userId,
    object: 'session',
    objectId: sessionId,
    action: 'revoked',
    details: { method: 'mobile' },
  })
  return true
}
