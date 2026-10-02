import { decodeJwt } from 'jose'
import { eq } from 'drizzle-orm'
import { captureException } from '@shared/lib/error-reporting'
import { db } from '@shared/lib/db'
import { user } from '@shared/lib/db/schema'
import { PLATFORM_AUTH_PROVIDER_ID } from '@shared/lib/services/platform-auth-service'
import { isPlatformControlledAuth } from './auth-settings'

// The platform's OIDC issuer namespaces its custom claims. The deployment
// grant carries the same value as a bare `role`.
const PLATFORM_ROLE_CLAIM = 'https://platform.skillfulagents.dev/claims/role'

/** Platform org role → deployment role. */
const DEPLOYMENT_ROLE = new Map<unknown, 'admin' | 'user'>([
  ['owner', 'admin'],
  ['admin', 'admin'],
  ['member', 'user'],
])

/** A platform org role as a deployment role: owners and admins administer the deployment, everyone else is a user. */
export function deploymentRoleFor(platformRole: unknown): 'admin' | 'user' {
  return DEPLOYMENT_ROLE.get(platformRole) ?? 'user'
}

/**
 * On a platform-controlled deployment the platform owns team roles, so every
 * sign-in overwrites the local role with the one the platform just sent. A
 * missing or unknown value becomes `user` and is reported rather than refusing
 * the sign-in. No-op on any other deployment.
 */
export async function applyPlatformRole(userId: string, platformRole: unknown): Promise<void> {
  if (!isPlatformControlledAuth()) return
  if (!DEPLOYMENT_ROLE.has(platformRole)) {
    captureException(new Error('Unrecognized platform role claim'), {
      tags: { component: 'platform-role' },
      extra: { platformRole },
    })
  }
  await db.update(user).set({ role: deploymentRoleFor(platformRole) }).where(eq(user.id, userId)).run()
}

/**
 * Browser sign-in: Better Auth drops a `role` returned from `mapProfileToUser`
 * (the admin plugin marks it `input: false`), so the role is read from the
 * id_token on the platform account row being written. A row without an
 * id_token (the desktop exchange writes those) is skipped.
 */
export async function applyPlatformRoleFromAccount(account: { providerId: string; userId: string; idToken?: string | null }): Promise<void> {
  if (account.providerId !== PLATFORM_AUTH_PROVIDER_ID || !account.idToken || !isPlatformControlledAuth()) return
  await applyPlatformRole(account.userId, decodeJwt(account.idToken)[PLATFORM_ROLE_CLAIM])
}
