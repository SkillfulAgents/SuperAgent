import { lt } from 'drizzle-orm'
import { captureException } from '@shared/lib/error-reporting'
import { db } from '@shared/lib/db'
import { tokenExchangeJti } from '@shared/lib/db/schema'
import { decodeOrgIdFromToken } from '@shared/lib/platform-auth/decode-org-id'
import { PLATFORM_AUTH_PROVIDER_ID } from '@shared/lib/services/platform-auth-service'
import { getAuth } from './index'
import { getAppBaseUrl } from './config'
import { verifyOidcJwt } from './oidc-jwt'
import { getAuthProviderIssuer, isAuthProviderEnabled } from './provider-config'
import {
  DEPLOYMENT_ASSERTION_TYP,
  DeploymentGrantClaimsSchema,
  MAX_GRANT_LIFETIME_SEC,
  type DeploymentGrantClaims,
  type TokenExchangeErrorCode,
  type TokenExchangeSuccess,
} from './token-exchange-schema'

// Allow small clock drift between platform and deployment when checking
// the grant's maximum lifetime.
const CLOCK_SKEW_SEC = 5

/**
 * OAuth error for the token endpoint. `description` must never disclose
 * whether an email, membership, account mapping, or jti exists.
 */
export class TokenExchangeError extends Error {
  constructor(
    public readonly code: TokenExchangeErrorCode,
    public readonly description?: string,
  ) {
    super(description ?? code)
    this.name = 'TokenExchangeError'
  }
}

export interface TokenExchangeRequestMeta {
  userAgent?: string
  ipAddress?: string
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: string }).code
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true
  return /unique constraint/i.test(error.message)
}

/**
 * Verify the platform-signed JWT authorization grant: signature via the
 * platform JWKS, issuer, audience (this deployment's configured base URL —
 * never derived from request headers), explicit typ, and payload shape.
 */
async function verifyGrant(assertion: string): Promise<DeploymentGrantClaims> {
  // Gate on the same provider that backs interactive login: if platform login
  // is unconfigured or explicitly disabled, no session may be minted here.
  const issuer = getAuthProviderIssuer(PLATFORM_AUTH_PROVIDER_ID)
  if (!issuer || !isAuthProviderEnabled(PLATFORM_AUTH_PROVIDER_ID)) {
    throw new TokenExchangeError('invalid_grant')
  }
  // Same canonical form the platform signs (origin + path, no trailing
  // slash), so an operator-supplied trailing slash can't break verification.
  const audience = getAppBaseUrl().replace(/\/+$/, '')

  let payload: unknown
  try {
    const result = await verifyOidcJwt(assertion, {
      issuer,
      audience,
      algorithms: ['RS256'],
      typ: DEPLOYMENT_ASSERTION_TYP,
    })
    payload = result.payload
  } catch {
    throw new TokenExchangeError('invalid_grant')
  }

  const parsed = DeploymentGrantClaimsSchema.safeParse(payload)
  if (!parsed.success) {
    throw new TokenExchangeError('invalid_grant')
  }
  const claims = parsed.data

  const nowSec = Math.floor(Date.now() / 1000)
  if (claims.exp > nowSec + MAX_GRANT_LIFETIME_SEC + CLOCK_SKEW_SEC) {
    throw new TokenExchangeError('invalid_grant')
  }
  // Not issued in the future (jose does not check iat by default).
  if (claims.iat > nowSec + CLOCK_SKEW_SEC) {
    throw new TokenExchangeError('invalid_grant')
  }
  // Exactly this deployment as the sole audience: jose accepts any array
  // containing the value, but a grant is minted for one deployment only.
  if (claims.aud !== audience) {
    throw new TokenExchangeError('invalid_grant')
  }

  // Org gate: identical to interactive login — a grant minted for another
  // org's deployment can never create a session here.
  const deploymentOrg = decodeOrgIdFromToken(process.env.PLATFORM_TOKEN ?? '')
  if (deploymentOrg && claims.org_id !== deploymentOrg) {
    throw new TokenExchangeError('invalid_grant')
  }

  if (claims.email_verified !== true) {
    throw new TokenExchangeError('invalid_grant')
  }

  return claims
}

/**
 * Atomically consume the grant's jti. The INSERT's primary-key constraint is
 * the replay gate: only the request whose insert lands may continue.
 */
function consumeJti(jti: string, expSec: number): void {
  try {
    // Opportunistic TTL cleanup keeps the table bounded.
    db.delete(tokenExchangeJti).where(lt(tokenExchangeJti.expiresAt, new Date())).run()
    const result = db
      .insert(tokenExchangeJti)
      .values({ jti, expiresAt: new Date(expSec * 1000) })
      .onConflictDoNothing()
      .run()
    if (result.changes === 0) {
      throw new TokenExchangeError('invalid_grant')
    }
  } catch (error) {
    if (error instanceof TokenExchangeError) throw error
    // Replay is a normal conflict (handled above); reaching here means the
    // replay table itself is failing — report it (never the jti value).
    captureException(error, { tags: { component: 'token-exchange', operation: 'jti-consume' } })
    throw new TokenExchangeError('invalid_grant')
  }
}

type AuthContext = Awaited<ReturnType<typeof getAuth>['$context']>

/**
 * Resolve the Better Auth user for the grant, provisioning on first exchange.
 *
 * Resolution order (per the stable-identity contract):
 *  1. Existing `(providerId, accountId)` account mapping wins — even over a
 *     later email change on the platform side.
 *  2. Otherwise the verified, normalized email resolves to the existing user
 *     (linking the platform identity) or provisions a new user.
 *
 * All writes go through Better Auth's internal adapter so database hooks run:
 * first-user bootstrap, pending-approval banning, and session limits behave
 * exactly as they do for browser OIDC login.
 */
async function resolveUser(ctx: AuthContext, claims: DeploymentGrantClaims) {
  const providerId = PLATFORM_AUTH_PROVIDER_ID
  const email = claims.email.trim().toLowerCase()

  type FoundUser = NonNullable<
    Awaited<ReturnType<AuthContext['internalAdapter']['findOAuthUser']>>
  >['user']

  // Link the platform identity to an existing user, honoring the app's
  // account-linking policy.
  // Widen: the inferred options type only carries the literal keys set in
  // our config, but the runtime policy honors all linking options.
  const linkPlatformMapping = async (user: FoundUser) => {
    const linking = ctx.options.account?.accountLinking as
      | {
          enabled?: boolean
          disableImplicitLinking?: boolean
          requireLocalEmailVerified?: boolean
        }
      | undefined
    if (linking?.enabled === false || linking?.disableImplicitLinking === true) {
      throw new TokenExchangeError('invalid_grant')
    }
    if ((linking?.requireLocalEmailVerified ?? true) && !user.emailVerified) {
      throw new TokenExchangeError('invalid_grant')
    }
    await ctx.internalAdapter.linkAccount({
      providerId,
      accountId: claims.sub,
      userId: user.id,
    })
  }

  const attempt = async () => {
    const found = await ctx.internalAdapter.findOAuthUser(email, claims.sub, providerId)
    if (found?.linkedAccount) {
      return found.user
    }

    if (found) {
      // User exists by email but has no platform mapping yet.
      await linkPlatformMapping(found.user)
      if (!found.user.emailVerified && found.user.email === email) {
        await ctx.internalAdapter.updateUser(found.user.id, { emailVerified: true })
      }
      return found.user
    }

    const created = await ctx.internalAdapter.createOAuthUser(
      {
        email,
        name: claims.name?.trim() || email,
        emailVerified: true,
      },
      {
        providerId,
        accountId: claims.sub,
      },
    )
    if (!created?.user) {
      throw new TokenExchangeError('invalid_grant')
    }
    return created.user
  }

  try {
    return await attempt()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    // A concurrent exchange won an insert race. Two cases:
    //  - same subject: the winner persisted our (providerId, sub) mapping;
    //  - different subject, same email: the winner created the user, and
    //    this subject's mapping does not exist yet.
    // Either way, reload and make sure THIS subject's mapping is persisted
    // before any session is minted for it.
    const winner = await ctx.internalAdapter.findOAuthUser(email, claims.sub, providerId)
    if (!winner) {
      throw new TokenExchangeError('invalid_grant')
    }
    if (winner.linkedAccount) {
      return winner.user
    }
    try {
      await linkPlatformMapping(winner.user)
    } catch (linkError) {
      // Yet another concurrent linker may have won; anything else is real.
      if (linkError instanceof TokenExchangeError) throw linkError
      if (!isUniqueConstraintError(linkError)) throw linkError
    }
    const final = await ctx.internalAdapter.findOAuthUser(email, claims.sub, providerId)
    if (!final?.linkedAccount) {
      throw new TokenExchangeError('invalid_grant')
    }
    return final.user
  }
}

/**
 * RFC 7523 exchange: verify a platform-issued JWT authorization grant,
 * atomically consume its jti, resolve/provision the Better Auth user, and
 * return an OAuth bearer response backed by a Better Auth session.
 */
export async function exchangeDeploymentGrant(
  assertion: string,
  meta: TokenExchangeRequestMeta = {},
): Promise<TokenExchangeSuccess> {
  const claims = await verifyGrant(assertion)

  // Only after full cryptographic + claim validation: burn the jti.
  consumeJti(claims.jti, claims.exp)

  const auth = getAuth()
  const ctx = await auth.$context

  const user = await resolveUser(ctx, claims)

  // Banned/pending enforcement. The admin plugin's session.create.before hook
  // only runs inside an endpoint context, so enforce here explicitly —
  // including the pending-approval ban applied by the user.create.after hook
  // during first-exchange provisioning. Mirrors the plugin's banExpires
  // auto-unban.
  const fresh = await ctx.internalAdapter.findUserById(user.id)
  if (!fresh) {
    // Invariant violation: resolveUser just produced this user. Masked to the
    // client as a generic denial, but a systemic occurrence must be visible.
    captureException(new Error('token exchange: resolved user missing after provisioning'), {
      tags: { component: 'token-exchange', operation: 'user-missing' },
      extra: { userId: user.id },
    })
    throw new TokenExchangeError('invalid_grant')
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
      throw new TokenExchangeError('invalid_grant')
    }
  }

  // Session hygiene: record where this session came from so users can see
  // and revoke it in the sessions list.
  const session = await ctx.internalAdapter.createSession(fresh.id, false, {
    userAgent: meta.userAgent?.slice(0, 512) || 'token-exchange',
    ipAddress: meta.ipAddress ?? '',
  })
  if (!session) {
    captureException(new Error('token exchange: session creation returned no session'), {
      tags: { component: 'token-exchange', operation: 'session-create' },
      extra: { userId: fresh.id },
    })
    throw new TokenExchangeError('invalid_grant')
  }

  const expiresIn = Math.max(
    0,
    Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000),
  )

  return {
    access_token: session.token,
    token_type: 'Bearer',
    expires_in: expiresIn,
  }
}
