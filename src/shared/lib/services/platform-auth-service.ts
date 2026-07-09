import { errors as joseErrors } from 'jose'
import { eq, and, desc } from 'drizzle-orm'

import { getSettings, mutateSettings, type PlatformAuthSettings } from '@shared/lib/config/settings'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { fetchPlatformJson } from '@shared/lib/platform-auth/platform-fetch'
import { PlatformAuthSettingsSchema, PlatformAccountInfoSchema } from '@shared/lib/types/skillset-schema'
import { captureException } from '@shared/lib/error-reporting'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getAuthProviderIssuer } from '@shared/lib/auth/provider-config'
import { verifyOidcJwt } from '@shared/lib/auth/oidc-jwt'
import { db } from '@shared/lib/db'
import { authAccount } from '@shared/lib/db/schema'

export type PlatformAuthRecord = PlatformAuthSettings

export type PlatformAuthSource = 'settings' | 'env' | null


// Spec for the org access tokens minted by the platform OIDC issuer.
const PLATFORM_ORG_ACCESS_TOKEN_AUDIENCE = 'platform-org-runtime'
const PLATFORM_ORG_ACCESS_TOKEN_ALG = 'RS256'
const PLATFORM_ORG_ACCESS_TOKEN_TYP = 'JWT'
const PLATFORM_AUTH_PROVIDER_ID = 'platform'

export interface VerifiedPlatformOrgAccessToken {
  orgId: string
  iss: string
  aud: string
  iat: number
  exp: number
  kid: string | null
}

export async function verifyPlatformOrgAccessTokenSigned(
  token: string,
  options: { issuer: string },
): Promise<VerifiedPlatformOrgAccessToken> {
  const { payload, protectedHeader } = await verifyOidcJwt(token, {
    issuer: options.issuer,
    audience: PLATFORM_ORG_ACCESS_TOKEN_AUDIENCE,
    algorithms: [PLATFORM_ORG_ACCESS_TOKEN_ALG],
    typ: PLATFORM_ORG_ACCESS_TOKEN_TYP,
  })
  const orgIdValue = payload['orgId']
  if (typeof orgIdValue !== 'string' || orgIdValue.length === 0) {
    throw new joseErrors.JWTClaimValidationFailed(
      'orgId claim is required',
      payload,
      'orgId',
      'missing',
    )
  }
  return {
    orgId: orgIdValue,
    iss: typeof payload.iss === 'string' ? payload.iss : options.issuer,
    aud: Array.isArray(payload.aud)
      ? String(payload.aud[0] ?? '')
      : typeof payload.aud === 'string'
        ? payload.aud
        : '',
    iat: typeof payload.iat === 'number' ? payload.iat : 0,
    exp: typeof payload.exp === 'number' ? payload.exp : 0,
    kid: typeof protectedHeader.kid === 'string' ? protectedHeader.kid : null,
  }
}

export interface PlatformAuthStatus {
  connected: boolean
  tokenPreview: string | null
  email: string | null
  label: string | null
  orgId: string | null
  orgName: string | null
  role: string | null
  /** Global platform user identity (Supabase auth UUID) — used for analytics. */
  userId: string | null
  /** Per-org membership id (sub_…) — used for request attribution. */
  memberId: string | null
  createdAt: string | null
  updatedAt: string | null
  source: PlatformAuthSource
}

interface SavePlatformAuthInput {
  token: string
  email?: string | null
  label?: string | null
  orgId?: string | null
  orgName?: string | null
  role?: string | null
  userId?: string | null
  memberId?: string | null
}

/**
 * Validate a personal access key against the platform proxy and return its
 * account identity. Used for manually-pasted keys (the OAuth flow already
 * carries this metadata in the redirect). Throws {@link PlatformRequestError}
 * (status 400) on an invalid/revoked key or (5xx) an unreachable platform.
 */
async function fetchPlatformAccountInfo(token: string) {
  return fetchPlatformJson({
    path: '/v1/account',
    token,
    schema: PlatformAccountInfoSchema,
    area: 'platform-auth',
    // Any auth/bad-request failure for a pasted key means it's invalid/revoked.
    mapStatusError: (status) =>
      status === 400 || status === 401 || status === 403
        ? { message: 'This access key is invalid or has been revoked.', status: 400 }
        : { message: 'Could not validate this access key right now. Please try again.', status: 502 },
  })
}

function buildTokenPreview(token: string): string {
  if (token.length <= 12) {
    return token
  }
  return `${token.slice(0, 6)}...${token.slice(-4)}`
}

function warnInvalidEnvPlatformToken(reason: string, error?: unknown): void {
  console.warn(`[platform-auth] invalid PLATFORM_TOKEN: ${reason}`)
  captureException(error ?? new Error(`Invalid PLATFORM_TOKEN: ${reason}`), {
    tags: { area: 'platform-auth', op: 'verify-env-token' },
  })
}

// Verified env-managed status, populated once at startup by
// `initEnvManagedPlatformStatus()`. `undefined` = not initialized yet.
let cachedEnvManagedStatus: PlatformAuthStatus | null | undefined = undefined

function buildEnvManagedStatus(envToken: string, orgId: string | null): PlatformAuthStatus {
  return {
    connected: true,
    tokenPreview: buildTokenPreview(envToken),
    email: null,
    label: 'Managed by organization',
    orgId,
    orgName: null,
    role: null,
    // Env-managed org tokens carry no per-user identity; attribution memberId
    // for these comes from the Better Auth `authAccount` table, not here.
    userId: null,
    memberId: null,
    createdAt: null,
    updatedAt: null,
    source: 'env',
  }
}

// Verifies PLATFORM_TOKEN against the issuer JWKS at startup; warns on failure.
export async function initEnvManagedPlatformStatus(): Promise<void> {
  // The env token (and so the org the introspect resolves against) may have
  // changed since the cache was filled.
  enrichedAccountCache.clear()
  if (!isAuthMode()) {
    cachedEnvManagedStatus = null
    return
  }
  const envToken = process.env.PLATFORM_TOKEN?.trim()
  if (!envToken) {
    cachedEnvManagedStatus = null
    return
  }
  const issuer = getAuthProviderIssuer(PLATFORM_AUTH_PROVIDER_ID)
  if (!issuer) {
    warnInvalidEnvPlatformToken('no issuer configured for org access token verification')
    cachedEnvManagedStatus = buildEnvManagedStatus(envToken, null)
    return
  }
  try {
    const verified = await verifyPlatformOrgAccessTokenSigned(envToken, { issuer })
    cachedEnvManagedStatus = buildEnvManagedStatus(envToken, verified.orgId)
  } catch (error) {
    const reason =
      error instanceof joseErrors.JWTExpired
        ? 'token expired'
        : error instanceof joseErrors.JWTClaimValidationFailed
          ? `claim validation failed: ${error.claim ?? 'unknown'}`
          : error instanceof joseErrors.JOSEError
            ? `signature verification failed: ${error.code}`
            : 'verification failed'
    warnInvalidEnvPlatformToken(reason, error)
    cachedEnvManagedStatus = buildEnvManagedStatus(envToken, null)
  }
}

export function _resetEnvManagedPlatformStatusForTest(): void {
  cachedEnvManagedStatus = undefined
  enrichedAccountCache.clear()
}

function readRecord(): PlatformAuthRecord | null {
  const raw = getSettings().platformAuth
  if (!raw) return null
  // Validate at the boundary; a corrupt settings.json shouldn't crash callers
  // mid-request, but we do want to see it in Sentry.
  const parsed = PlatformAuthSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    captureException(parsed.error, { tags: { area: 'platform-auth', op: 'read' } })
    return null
  }
  return parsed.data
}

function writeRecord(record: PlatformAuthRecord | null): void {
  // Serialized fresh-read + atomic write so a background token refresh can't
  // lose-update a concurrent settings change or clobber real settings from a
  // defaulted cache.
  mutateSettings((settings) => {
    settings.platformAuth = record ?? undefined
  })
}

/**
 * Reconcile skillset configs + installed metadata after an auth change.
 *
 * Provider-polymorphic: each provider's `isConfigValid` / `isInstalledValid`
 * decides what belongs. Lives behind a dynamic import to break a module
 * cycle (skillset-reconcile → skillset-provider → platform-provider → here).
 */
async function reconcileAfterAuthChange(): Promise<void> {
  try {
    const mod = await import('./skillset-reconcile')
    mod.reconcileSkillsetConfigsForCurrentAuth()
    await mod.reconcileInstalledForCurrentAuth()
  } catch (error) {
    captureException(error, { tags: { area: 'platform-auth', op: 'reconcile' } })
  }
}

/**
 * Notify the PlatformService of a connect/disconnect so it can refresh or clear
 * its cached billing/account snapshot. Dynamic import breaks the module cycle
 * (platform-service → platform-auth-service → here).
 */
function notifyPlatformServiceAuthChanged(connected: boolean): void {
  void import('./platform-service')
    .then((mod) => mod.platformService.onAuthChanged(connected))
    .catch((error) => captureException(error, { tags: { area: 'platform-auth', op: 'notify-service' } }))
  // The desktop notifications subscription follows platform connectivity:
  // start on connect (self-gates on auth mode), tear down on disconnect.
  void import('../scheduler/platform-notifications-manager')
    .then((mod) =>
      connected
        ? mod.platformNotificationsManager.start()
        : mod.platformNotificationsManager.stop(),
    )
    .catch((error) =>
      captureException(error, { tags: { area: 'platform-auth', op: 'notify-notifications' } }),
    )
}

function getEnvManagedStatus(): PlatformAuthStatus | null {
  if (cachedEnvManagedStatus !== undefined) return cachedEnvManagedStatus
  // Pre-init fallback: orgId stays null until verification completes.
  if (!isAuthMode()) return null
  const envToken = process.env.PLATFORM_TOKEN?.trim()
  if (!envToken) return null
  return buildEnvManagedStatus(envToken, null)
}

const PLATFORM_USER_ID_CLAIM = 'https://platform.skillfulagents.dev/claims/user_id'

/**
 * Extract the platform user_id from a stored OIDC ID token. Returns null if
 * the claim is absent (issuer not yet updated) or the token is malformed.
 */
function extractUserIdFromIdToken(idToken: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1], 'base64url').toString(),
    )
    const val = payload[PLATFORM_USER_ID_CLAIM]
    return typeof val === 'string' ? val : null
  } catch {
    return null
  }
}

/**
 * Look up the platform OIDC account for a Better Auth user and return the
 * global platform user_id extracted from the stored ID token. Returns null
 * if no platform account exists or the issuer hasn't emitted the claim yet.
 */
function getPlatformOidcUserId(betterAuthUserId: string): string | null {
  const row = db
    .select({ idToken: authAccount.idToken })
    .from(authAccount)
    .where(
      and(
        eq(authAccount.userId, betterAuthUserId),
        eq(authAccount.providerId, PLATFORM_AUTH_PROVIDER_ID),
      ),
    )
    .orderBy(desc(authAccount.createdAt))
    .limit(1)
    .get()
  if (!row?.idToken) return null
  return extractUserIdFromIdToken(row.idToken)
}

export function getPlatformAuthStatus(userId?: string): PlatformAuthStatus {
  const envManaged = getEnvManagedStatus()
  if (envManaged) {
    if (!envManaged.userId && userId) {
      return { ...envManaged, userId: getPlatformOidcUserId(userId) }
    }
    return envManaged
  }

  const record = readRecord()
  if (record) {
    return {
      connected: true,
      tokenPreview: record.tokenPreview,
      email: record.email,
      label: record.label,
      orgId: record.orgId,
      orgName: record.orgName,
      role: record.role,
      userId: record.userId,
      memberId: record.memberId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      source: 'settings',
    }
  }

  return {
    connected: false,
    tokenPreview: null,
    email: null,
    label: null,
    orgId: null,
    orgName: null,
    role: null,
    userId: null,
    memberId: null,
    createdAt: null,
    updatedAt: null,
    source: null,
  }
}

// The org JWT carries only `orgId`, so email/orgName/role come from a
// `/v1/account` introspect. `updatedAt` stays null: env connections have no
// "last changed" anchor, so the introspect time would be meaningless.
interface EnrichedEnvAccount {
  email: string | null
  orgName: string | null
  role: string | null
}

// Introspection is memoized per user: the Account screen re-fetches the status
// on every mount/focus, and the membership it reflects changes rarely.
// Failures are cached too, so a proxy without `/v1/account` org-JWT support
// doesn't cost a failing round-trip (and a Sentry event) per page view.
const ENRICHED_ACCOUNT_TTL_MS = 5 * 60 * 1000
const enrichedAccountCache = new Map<
  string,
  { account: EnrichedEnvAccount | null; expiresAt: number }
>()

async function introspectEnvManagedAccount(userId: string): Promise<EnrichedEnvAccount | null> {
  const token = getPlatformAccessToken()
  if (!token) return null
  try {
    // Dynamic import breaks the module cycle (platform-attribution imports this
    // service for the token + stored member id).
    const { runWithRequestUser } = await import('@shared/lib/platform-attribution')
    const account = await runWithRequestUser(userId, () =>
      fetchPlatformJson({
        path: '/v1/account',
        token,
        schema: PlatformAccountInfoSchema,
        area: 'platform-auth',
        mapStatusError: (status) => ({ message: 'Account introspection failed', status }),
      }),
    )
    return { email: account.email, orgName: account.orgName, role: account.role }
  } catch (error) {
    captureException(error, { tags: { area: 'platform-auth', op: 'introspect-env-account' } })
    return null
  }
}

/**
 * Like {@link getPlatformAuthStatus}, but for env-managed (org-JWT) connections
 * fills email/orgName/role by introspecting the acting member's account.
 * Opaque-key (settings) and disconnected statuses are returned as-is.
 */
export async function getEnrichedPlatformAuthStatus(userId?: string): Promise<PlatformAuthStatus> {
  const base = getPlatformAuthStatus(userId)
  if (base.source !== 'env' || !base.connected || !userId) return base

  let entry = enrichedAccountCache.get(userId)
  if (!entry || entry.expiresAt <= Date.now()) {
    entry = {
      account: await introspectEnvManagedAccount(userId),
      expiresAt: Date.now() + ENRICHED_ACCOUNT_TTL_MS,
    }
    enrichedAccountCache.set(userId, entry)
  }

  const { account } = entry
  if (!account) return base

  return {
    ...base,
    email: account.email,
    orgName: account.orgName,
    role: account.role,
  }
}

export async function savePlatformAuth(_userId: string, input: SavePlatformAuthInput): Promise<PlatformAuthStatus> {
  const trimmedToken = input.token.trim()
  if (!trimmedToken) {
    throw new Error('Token is required')
  }

  // Token-only saves (the manual "Add key" paste) arrive with no metadata.
  // Validate the key against the platform and enrich it before persisting —
  // this rejects bad keys with a clear message and fills the analytics/display
  // fields the OAuth redirect would otherwise provide.
  let enriched = input
  if (!input.orgId && !input.userId && !input.memberId) {
    const account = await fetchPlatformAccountInfo(trimmedToken)
    enriched = {
      ...input,
      email: input.email ?? account.email,
      orgId: account.orgId,
      orgName: account.orgName,
      role: account.role,
      userId: account.userId,
      memberId: account.memberId,
    }
  }

  const existing = readRecord()
  const newOrgId = enriched.orgId?.trim() || null
  const orgChanged = existing?.orgId !== newOrgId

  const now = new Date().toISOString()
  const record: PlatformAuthRecord = PlatformAuthSettingsSchema.parse({
    token: trimmedToken,
    tokenPreview: buildTokenPreview(trimmedToken),
    email: enriched.email?.trim() || null,
    label: enriched.label?.trim() || null,
    orgId: newOrgId,
    orgName: enriched.orgName?.trim() || null,
    role: enriched.role?.trim() || null,
    userId: enriched.userId?.trim() || null,
    memberId: enriched.memberId?.trim() || null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  writeRecord(record)

  if (orgChanged) {
    // Auth state changed — sweep stale configs + installed files for the
    // previous org. Runs *after* writing the new record so the polymorphic
    // reconcile sees the current auth.
    await reconcileAfterAuthChange()
  }

  notifyPlatformServiceAuthChanged(true)
  return getPlatformAuthStatus()
}

export function getPlatformAccessToken(_userId?: string): string | null {
  const envToken = process.env.PLATFORM_TOKEN?.trim()
  if (isAuthMode() && envToken) return envToken
  return readRecord()?.token ?? null
}

/**
 * The per-org membership id (sub_…) for the settings-stored connection, if any.
 *
 * Used as an attribution fallback for org-scoped tokens stored in settings. The
 * primary attribution source remains the Better Auth `authAccount` table (env /
 * platform-OAuth path). Opaque `plat_sa_` access keys are already member-scoped
 * server-side and do not use this.
 */
export function getStoredPlatformMemberId(): string | null {
  return readRecord()?.memberId ?? null
}

/**
 * Re-introspect the settings-stored token via `/v1/account` and update the
 * record if the identity changed (email/org/role/userId/memberId). Keeps the
 * analytics userId and org details fresh and catches org switches.
 *
 * No-op for env-managed connections (org-scoped tokens are rejected by
 * `/v1/account`) and on transient/invalid-token errors (teardown is the
 * revoke flow's job). Returns true if the record was updated.
 */
export async function refreshStoredPlatformAccount(): Promise<boolean> {
  if (isAuthMode() && process.env.PLATFORM_TOKEN?.trim()) return false
  const record = readRecord()
  if (!record) return false

  let account
  try {
    account = await fetchPlatformAccountInfo(record.token)
  } catch {
    // Transient or now-invalid token — leave the existing record untouched.
    return false
  }

  const unchanged =
    record.email === (account.email ?? null) &&
    record.orgId === account.orgId &&
    record.orgName === account.orgName &&
    record.role === account.role &&
    record.userId === account.userId &&
    record.memberId === account.memberId
  if (unchanged) return false

  // Pass the resolved metadata through so savePlatformAuth persists it without
  // re-introspecting (orgId present → enrichment is skipped).
  await savePlatformAuth('local', {
    token: record.token,
    email: account.email,
    label: record.label,
    orgId: account.orgId,
    orgName: account.orgName,
    role: account.role,
    userId: account.userId,
    memberId: account.memberId,
  })
  return true
}

async function clearPlatformAuth(): Promise<void> {
  writeRecord(null)
  await reconcileAfterAuthChange()
  notifyPlatformServiceAuthChanged(false)
}

export async function revokePlatformTokenRemotely(): Promise<boolean> {
  const token = readRecord()?.token
  if (!token) return false

  const proxyBase = getPlatformProxyBaseUrl()
  if (!proxyBase) return false

  try {
    const res = await fetch(`${proxyBase}/v1/revoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    return res.ok
  } catch (error) {
    captureException(error, { tags: { area: 'platform-auth', op: 'revoke' } })
    return false
  }
}

export async function revokePlatformToken(options?: { clearLocal?: boolean }): Promise<boolean> {
  const success = await revokePlatformTokenRemotely()
  if (options?.clearLocal !== false) {
    await clearPlatformAuth()
  }
  return success
}
