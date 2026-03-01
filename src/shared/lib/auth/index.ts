import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { and, eq, sql } from 'drizzle-orm'
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
      // When trustedOrigins is explicitly configured, use that list.
      // Otherwise allow all origins (matches spec: "Default: allow all origins").
      trustedOrigins: trustedOrigins.length > 0
        ? trustedOrigins
        : (request) => {
            const origin = request?.headers.get('origin')
            return origin ? [origin] : []
          },
      databaseHooks: {
        user: {
          create: {
            after: async (createdUser) => {
              try {
                // Atomic: only promote if this is the sole user in the table
                const result = db
                  .update(schema.user)
                  .set({ role: 'admin' })
                  .where(
                    and(
                      eq(schema.user.id, createdUser.id),
                      sql`(SELECT count(*) FROM user) = 1`
                    )
                  )
                  .run()
                if (result.changes > 0) {
                  console.log(`First user ${createdUser.email} promoted to admin`)
                }
              } catch (err) {
                console.error('Failed to check/set admin role:', err)
              }
            },
          },
        },
      },
    })
  }
  return _auth
}
