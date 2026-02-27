import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { db, sqlite } from '@shared/lib/db'
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
            after: async (user) => {
              // Make the first user an admin automatically.
              // Race-safe: check count after this user was already inserted.
              try {
                const result = sqlite.prepare('SELECT COUNT(*) as count FROM user').get() as { count: number }
                if (result.count === 1) {
                  // This is the first (and only) user — promote to admin
                  sqlite.prepare('UPDATE user SET role = ? WHERE id = ?').run('admin', user.id)
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
