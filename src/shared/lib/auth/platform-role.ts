import { decodeJwt } from 'jose'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { user } from '@shared/lib/db/schema'
import { captureException } from '@shared/lib/error-reporting'
import { PLATFORM_CLAIMS } from '@shared/lib/platform-auth/claims'
import { PLATFORM_AUTH_PROVIDER_ID } from '@shared/lib/services/platform-auth-service'
import { isPlatformControlledAuth } from './auth-settings'
import { PlatformOrgRoleSchema } from './platform-role-schema'

// On a platform-controlled deployment a member joins with their Platform role:
// owners and admins become admins, members become users. Only the sign-in that
// creates their user sets it, and nothing here runs again, so a role changed
// later in Settings > Users stays and someone who links Platform to a user they
// already had keeps their role. These deployments skip the first-user promotion
// in the user create hook; it runs here only when the platform sent no role.

const REPORT_TAGS = { area: 'auth', op: 'platform-role' }

/**
 * Give the user this sign-in just created their Platform role, before the
 * sign-in's session exists. A missing or unknown role is reported, and the
 * self-hosted bootstrap applies instead: admin if they are the only user.
 * Never throws: the user already exists, so failing the sign-in would not
 * apply the role on a retry.
 */
export async function applyPlatformJoinRole(userId: string, platformRole: unknown): Promise<void> {
  if (!isPlatformControlledAuth()) return
  const parsed = PlatformOrgRoleSchema.safeParse(platformRole)
  try {
    if (parsed.success) {
      await db.update(user)
        .set({ role: parsed.data === 'member' ? 'user' : 'admin' })
        .where(eq(user.id, userId))
        .run()
      return
    }
    captureException(new Error('Unrecognized platform role'), {
      tags: REPORT_TAGS,
      extra: { platformRole: typeof platformRole === 'string' ? platformRole.slice(0, 64) : typeof platformRole },
    })
    const result = await db.update(user)
      .set({ role: 'admin' })
      .where(and(eq(user.id, userId), sql`(SELECT count(*) FROM user) = 1`))
      .run()
    if (changesOf(result) > 0) console.log(`First user ${userId} promoted to admin: the platform sent no role`)
  } catch (error) {
    captureException(error, { tags: REPORT_TAGS })
  }
}

// Browser sign-in creates the user and then their platform account in one auth
// request, and only the account carries the id_token. Each request's endpoint
// context remembers the user it created, so the account hook can tell a join
// from a link to an existing user. This leans on Better Auth running the user
// create hook first and handing both hooks the request's endpoint context;
// oidc.integration.test.ts pins both. Were either to change, members would
// join with the default role.
const createdInRequest = new WeakMap<object, string>()

/** From the user create hook: this request created `userId`. */
export function noteUserCreated(context: object | null | undefined, userId: string): void {
  if (context) createdInRequest.set(context, userId)
}

/**
 * From the account create hook: when this request created the user and this is
 * their platform account, apply the role on its id_token, which Better Auth
 * verified in this same sign-in. The desktop exchange writes no id_token and
 * applies the grant's role itself.
 */
export async function applyPlatformJoinRoleFromAccount(
  account: { providerId: string; userId: string; idToken?: string | null },
  context: object | null | undefined,
): Promise<void> {
  if (account.providerId !== PLATFORM_AUTH_PROVIDER_ID || !account.idToken) return
  if (!context || createdInRequest.get(context) !== account.userId) return
  let platformRole: unknown
  try {
    platformRole = decodeJwt(account.idToken)[PLATFORM_CLAIMS.role]
  } catch (error) {
    captureException(error, { tags: REPORT_TAGS })
  }
  await applyPlatformJoinRole(account.userId, platformRole)
}
