import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { eq, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import * as schema from '@shared/lib/db/schema'
import { getOrCreateAuthSecret } from './secret'
import { getAppBaseUrl, getTrustedOrigins } from './config'

// Re-export isAuthMode from its own file (no better-auth imports)
// so consumers that only need the check don't pull in ESM deps.
export { isAuthMode } from './mode'

// Lazy singleton for the Better Auth instance
let _auth: ReturnType<typeof betterAuth> | null = null

/**
 * Get the Better Auth instance. Lazily created on first call.
 * Only valid when isAuthMode() is true.
 */
export function getAuth() {
  if (!_auth) {
    const trustedOrigins = getTrustedOrigins()

    _auth = betterAuth({
      database: drizzleAdapter(db, {
        provider: 'sqlite',
        schema: {
          user: schema.user,
          session: schema.authSession,
          account: schema.authAccount,
          verification: schema.verification,
        },
      }),
      emailAndPassword: {
        enabled: true,
      },
      plugins: [
        admin(),
      ],
      secret: getOrCreateAuthSecret(),
      baseURL: getAppBaseUrl(),
      ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
      databaseHooks: {
        user: {
          create: {
            after: async (createdUser) => {
              // Make the first user an admin automatically.
              // Race-safe: check count after this user was already inserted.
              try {
                const [{ count }] = await db
                  .select({ count: sql<number>`count(*)` })
                  .from(schema.user)
                if (count === 1) {
                  // This is the first (and only) user — promote to admin
                  await db
                    .update(schema.user)
                    .set({ role: 'admin' })
                    .where(eq(schema.user.id, createdUser.id))
                }
              } catch (error) {
                console.error('Failed to check/set first user as admin:', error)
              }
            },
          },
        },
      },
    })
  }
  return _auth
}
