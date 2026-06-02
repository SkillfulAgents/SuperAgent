import { AsyncLocalStorage } from 'node:async_hooks'

import { and, desc, eq } from 'drizzle-orm'

import { db } from '@shared/lib/db'
import { authAccount } from '@shared/lib/db/schema'
import { getPlatformAccessToken, getStoredPlatformMemberId } from '@shared/lib/services/platform-auth-service'

const PLATFORM_PROVIDER_ID = 'platform'

/** Unverified `orgId` claim, or null for opaque access keys. Used only for routing. */
export function decodeOrgIdFromToken(token: string): string | null {
  const segments = token.split('.')
  if (segments.length !== 3) return null
  try {
    const claims = JSON.parse(decodeBase64Url(segments[1])) as { orgId?: unknown }
    return typeof claims.orgId === 'string' && claims.orgId.length > 0 ? claims.orgId : null
  } catch {
    return null
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4)
  return Buffer.from(padded, 'base64').toString('utf8')
}

function getPlatformAccountIdForUserId(userId: string): string | null {
  const rows = db
    .select({ accountId: authAccount.accountId })
    .from(authAccount)
    .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, PLATFORM_PROVIDER_ID)))
    .orderBy(desc(authAccount.updatedAt))
    .limit(1)
    .all()
  return rows[0]?.accountId ?? null
}

// The acting member for the current request: prefer the Better Auth
// `authAccount` row (env / platform-OAuth path), then fall back to the
// member id persisted with a settings-stored connection (single-connection
// case). Opaque `plat_sa_` access keys are not org-scoped, so memberId is
// unused for them — this only matters if an org-scoped token lives in settings.
function resolveMemberIdForUserId(userId: string): string | null {
  return getPlatformAccountIdForUserId(userId) ?? getStoredPlatformMemberId()
}

// Org JWTs carry the acting member as `<token>::<memberId>` (proxy splits
// on `::` pre-verification). Opaque access keys pass through unchanged.
export interface Attribution {
  applyTo(headers: Headers): void
  bearerToken(): string
  getKey(): string
}

class PlatformAttribution implements Attribution {
  constructor(
    private readonly token: string,
    private readonly memberId: string | null,
    private readonly orgScoped: boolean,
  ) {}

  applyTo(headers: Headers): void {
    headers.set('Authorization', `Bearer ${this.bearerToken()}`)
  }

  bearerToken(): string {
    return this.orgScoped && this.memberId
      ? `${this.token}::${this.memberId}`
      : this.token
  }

  getKey(): string {
    if (!this.orgScoped) return 'access_key'
    return this.memberId ? `member:${this.memberId}` : 'org'
  }
}

function buildAttribution(memberId: string | null): Attribution | null {
  const token = getPlatformAccessToken()
  if (!token) return null
  const orgScoped = decodeOrgIdFromToken(token) !== null
  if (orgScoped && !memberId) return null
  return new PlatformAttribution(token, memberId, orgScoped)
}

const userContext = new AsyncLocalStorage<{ userId: string }>()
const attributionContext = new AsyncLocalStorage<{ auth: Attribution }>()

// Lazy: stores userId; memberId / token are resolved at attribution.current() time.
export function runWithRequestUser<T>(userId: string, fn: () => Promise<T> | T): Promise<T> | T {
  return userContext.run({ userId }, fn)
}

// Same as runWithRequestUser, but a null/undefined userId is a no-op scope.
export function runWithOptionalUser<T>(
  userId: string | null | undefined,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return userId ? userContext.run({ userId }, fn) : fn()
}

// Eager override: stores a pre-resolved Attribution; takes precedence over
// the request-user scope. Use when the natural request user isn't who we
// want to attribute to (see proxy.ts: attribute by connected_account owner).
export function runWithAttribution<T>(
  auth: Attribution | null,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return auth ? attributionContext.run({ auth }, fn) : fn()
}

function fromCurrentRequest(): Attribution | null {
  const userId = userContext.getStore()?.userId
  return userId ? buildAttribution(resolveMemberIdForUserId(userId)) : null
}

// True when the active platform token is an org JWT, so every proxy call must
// carry a per-request acting member. Opaque access keys and an unconfigured
// token return false.
function requiresActingMember(): boolean {
  const token = getPlatformAccessToken()
  return token !== null && decodeOrgIdFromToken(token) !== null
}

export const attribution = {
  fromCurrentRequest,
  fromUserId(userId: string): Attribution | null {
    return buildAttribution(resolveMemberIdForUserId(userId))
  },
  fromResourceCreator(ownerUserId: string | null): Attribution | null {
    return ownerUserId ? buildAttribution(getPlatformAccountIdForUserId(ownerUserId)) : null
  },
  current(): Attribution | null {
    return attributionContext.getStore()?.auth ?? fromCurrentRequest()
  },
  requiresActingMember,
} as const

export { installPlatformFetchInterceptor } from './install-fetch-interceptor'
