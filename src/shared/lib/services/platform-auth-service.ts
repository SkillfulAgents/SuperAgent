import { errors as joseErrors } from 'jose'

import { getSettings, updateSettings, type PlatformAuthSettings } from '@shared/lib/config/settings'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { PlatformAuthSettingsSchema, PlatformAccountInfoSchema } from '@shared/lib/types/skillset-schema'
import { captureException } from '@shared/lib/error-reporting'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getAuthProviderIssuer } from '@shared/lib/auth/provider-config'
import { verifyOidcJwt } from '@shared/lib/auth/oidc-jwt'

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
 * Raised when a token can't be validated against the platform. `status` is the
 * HTTP status the API route should surface (400 = bad/revoked key, 5xx =
 * transient). `message` is user-facing.
 */
export class PlatformTokenValidationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'PlatformTokenValidationError'
  }
}

/**
 * Validate a personal access key against the platform proxy and return its
 * account identity. Used for manually-pasted keys (the OAuth flow already
 * carries this metadata in the redirect). Throws PlatformTokenValidationError
 * on an invalid/revoked key or an unreachable platform.
 */
async function fetchPlatformAccountInfo(token: string) {
  const proxyBase = getPlatformProxyBaseUrl()
  if (!proxyBase) {
    throw new PlatformTokenValidationError('Platform proxy is not configured.', 500)
  }

  let res: Response
  try {
    res = await fetch(`${proxyBase}/v1/account`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (error) {
    captureException(error, { tags: { area: 'platform-auth', op: 'account-introspect' } })
    throw new PlatformTokenValidationError(
      'Could not reach the platform to validate this key. Please try again.',
      502,
    )
  }

  if (res.status === 401 || res.status === 403 || res.status === 400) {
    throw new PlatformTokenValidationError('This access key is invalid or has been revoked.', 400)
  }
  if (!res.ok) {
    throw new PlatformTokenValidationError(
      'Could not validate this access key right now. Please try again.',
      502,
    )
  }

  const data = await res.json().catch(() => null)
  const parsed = PlatformAccountInfoSchema.safeParse(data)
  if (!parsed.success) {
    captureException(parsed.error, { tags: { area: 'platform-auth', op: 'account-parse' } })
    throw new PlatformTokenValidationError('The platform returned an unexpected response.', 502)
  }
  return parsed.data
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
  const settings = getSettings()
  settings.platformAuth = record ?? undefined
  updateSettings(settings)
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

function getEnvManagedStatus(): PlatformAuthStatus | null {
  if (cachedEnvManagedStatus !== undefined) return cachedEnvManagedStatus
  // Pre-init fallback: orgId stays null until verification completes.
  if (!isAuthMode()) return null
  const envToken = process.env.PLATFORM_TOKEN?.trim()
  if (!envToken) return null
  return buildEnvManagedStatus(envToken, null)
}

export function getPlatformAuthStatus(_userId?: string): PlatformAuthStatus {
  const envManaged = getEnvManagedStatus()
  if (envManaged) return envManaged

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

async function clearPlatformAuth(): Promise<void> {
  writeRecord(null)
  await reconcileAfterAuthChange()
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
