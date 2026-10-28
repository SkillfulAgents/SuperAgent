import { captureException } from '@shared/lib/error-reporting'
import { getAuth } from './index'
import { withSessionAuditContext, type SessionCreationMethod } from './session-audit'

type InstalledClientMethod = Extract<SessionCreationMethod, 'token-exchange' | 'mobile'>
type AuthContext = Awaited<ReturnType<typeof getAuth>['$context']>

export interface InstalledClientRequestMeta {
  userAgent?: string
  ipAddress?: string
}

export class InstalledClientSessionError extends Error {
  constructor() {
    super('installed_client_session_denied')
    this.name = 'InstalledClientSessionError'
  }
}

export interface MintInstalledClientSessionOptions {
  userId: string
  method: InstalledClientMethod
  orgId?: string
  meta?: InstalledClientRequestMeta
  deviceId?: string
}

/**
 * The single session-issuance path for installed clients.
 *
 * Desktop token exchange and mobile pairing intentionally authenticate the
 * user differently, but once that authorization grant has been accepted they
 * must share session lifetime, banned-user enforcement, audit attribution,
 * and Better Auth hooks. Keeping those rules here prevents one installed
 * client from silently becoming a second, weaker token system.
 */
export async function mintInstalledClientSession({
  userId,
  method,
  orgId,
  meta = {},
  deviceId,
}: MintInstalledClientSessionOptions) {
  const ctx: AuthContext = await getAuth().$context
  const fresh = await ctx.internalAdapter.findUserById(userId)
  if (!fresh) {
    captureException(new Error('installed client session: user missing at session mint'), {
      tags: { component: 'installed-client-session', operation: 'user-missing', method },
      extra: { userId },
    })
    throw new InstalledClientSessionError()
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
      throw new InstalledClientSessionError()
    }
  }

  const session = await withSessionAuditContext({ method, ...(orgId ? { orgId } : {}) }, () =>
    ctx.internalAdapter.createSession(fresh.id, false, {
      userAgent: meta.userAgent?.slice(0, 512) || method,
      ipAddress: meta.ipAddress ?? '',
      ...(deviceId ? { deviceId } : {}),
    }),
  )
  if (!session) {
    captureException(new Error('installed client session: session creation returned no session'), {
      tags: { component: 'installed-client-session', operation: 'session-create', method },
      extra: { userId: fresh.id },
    })
    throw new InstalledClientSessionError()
  }

  return { session, user: fresh }
}
