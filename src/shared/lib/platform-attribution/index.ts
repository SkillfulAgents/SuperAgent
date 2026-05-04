import { AsyncLocalStorage } from 'node:async_hooks'

import { and, desc, eq } from 'drizzle-orm'

import { db } from '@shared/lib/db'
import { authAccount } from '@shared/lib/db/schema'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'

const PLATFORM_PROVIDER_ID = 'platform'

// ---- Token shape (routing only; not a trust check) ------------------------

/** Returns the unverified `orgId` claim, or null for opaque access keys. */
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

// ---- Member lookup --------------------------------------------------------

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

// ---- Attribution wire envelope --------------------------------------------

export interface Attribution {
  applyTo(headers: Headers): void
  toHeaderEntries(): Array<[string, string]>
  toExtraHeaderEntries(): Array<[string, string]>
  getKey(): string
}

class PlatformAttribution implements Attribution {
  constructor(
    private readonly token: string,
    private readonly memberId: string | null,
    private readonly orgScoped: boolean,
  ) {}

  applyTo(headers: Headers): void {
    for (const [name, value] of this.toHeaderEntries()) headers.set(name, value)
  }

  toHeaderEntries(): Array<[string, string]> {
    return [['Authorization', `Bearer ${this.token}`], ...this.toExtraHeaderEntries()]
  }

  toExtraHeaderEntries(): Array<[string, string]> {
    return this.orgScoped && this.memberId ? [['X-Platform-Member-Id', this.memberId]] : []
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

// ---- ALS scopes -----------------------------------------------------------

const userContext = new AsyncLocalStorage<{ userId: string }>()
const attributionContext = new AsyncLocalStorage<{ auth: Attribution }>()

export function runWithRequestUser<T>(userId: string, fn: () => Promise<T> | T): Promise<T> | T {
  return userContext.run({ userId }, fn)
}

export function runWithAttribution<T>(
  auth: Attribution | null,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return auth ? attributionContext.run({ auth }, fn) : fn()
}

// ---- Public factories -----------------------------------------------------

function fromCurrentRequest(): Attribution | null {
  const userId = userContext.getStore()?.userId
  return userId ? buildAttribution(getPlatformAccountIdForUserId(userId)) : null
}

export const attribution = {
  fromCurrentRequest,
  fromUserId(userId: string): Attribution | null {
    return buildAttribution(getPlatformAccountIdForUserId(userId))
  },
  fromResourceCreator(ownerUserId: string | null): Attribution | null {
    return ownerUserId ? buildAttribution(getPlatformAccountIdForUserId(ownerUserId)) : null
  },
  current(): Attribution | null {
    return attributionContext.getStore()?.auth ?? fromCurrentRequest()
  },
} as const

export { installPlatformFetchInterceptor } from './install-fetch-interceptor'
