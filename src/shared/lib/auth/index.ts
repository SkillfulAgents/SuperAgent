import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, genericOAuth } from 'better-auth/plugins'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import * as schema from '@shared/lib/db/schema'
import { getOrCreateAuthSecret } from './secret'
import { getAppBaseUrl, getTrustedOrigins } from './config'
import { getSettings, DEFAULT_AUTH_SETTINGS } from '@shared/lib/config/settings'
import { enforceMaxConcurrentSessions } from './session-enforcement'
import { getGenericOAuthProviderConfigs } from './provider-config'

// Re-export isAuthMode from its own file (no better-auth imports)
// so consumers that only need the check don't pull in ESM deps.
export { isAuthMode } from './mode'

// Lazy singleton for the Better Auth instance
let _auth: ReturnType<typeof betterAuth> | null = null

/**
 * Reset the Better Auth singleton so the next getAuth() call
 * picks up new settings (session duration, password policy, etc.).
 */
export function resetAuth() {
  _auth = null
}

/**
 * Get the Better Auth instance. Lazily created on first call.
 * Only valid when isAuthMode() is true.
 */
export function getAuth() {
  if (!_auth) {
    const trustedOrigins = getTrustedOrigins()
    const settings = getSettings()
    const authSettings = { ...DEFAULT_AUTH_SETTINGS, ...settings.auth }
    const oauthProviders = getGenericOAuthProviderConfigs()
    const oauthPlugin = oauthProviders.length > 0
      ? genericOAuth({
          config: oauthProviders,
        })
      : null

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
        minPasswordLength: authSettings.passwordMinLength,
        maxPasswordLength: authSettings.passwordMaxLength,
      },
      session: {
        expiresIn: (authSettings.sessionMaxLifetimeHrs ?? 24) * 3600,
        updateAge: (authSettings.sessionIdleTimeoutMin ?? 60) * 60,
      },
      user: {
        additionalFields: {
          mustChangePassword: {
            type: 'boolean',
            required: false,
            defaultValue: false,
            input: false, // users cannot set this on self-registration
          },
        },
      },
      plugins: [
        admin({
          defaultRole: authSettings.defaultUserRole === 'admin' ? 'admin' : 'user',
        }),
        ...(oauthPlugin ? [oauthPlugin] : []),
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

                // If admin approval is required and this is NOT the first user,
                // auto-ban them pending admin review.
                // Read fresh settings so runtime changes are picked up without
                // needing to recreate the Better Auth singleton.
                const currentSettings = getSettings()
                const currentAuth = { ...DEFAULT_AUTH_SETTINGS, ...currentSettings.auth }
                if (result.changes === 0 && currentAuth.requireAdminApproval) {
                  db.update(schema.user)
                    .set({ banned: true, banReason: 'Pending admin approval' })
                    .where(eq(schema.user.id, createdUser.id))
                    .run()
                  console.log(`User ${createdUser.email} requires admin approval`)
                }
              } catch (err) {
                console.error('Failed to check/set admin role:', err)
              }
            },
          },
        },
        account: {
          update: {
            after: async (account) => {
              // Auto-clear mustChangePassword when a user changes their password.
              // The changePassword endpoint calls updateAccount() which returns the
              // full row via .returning(), so we have userId and providerId here.
              // Admin setUserPassword uses updateMany (returns count, not row) — no-op.
              try {
                if (account && account.providerId === 'credential' && account.userId) {
                  db.update(schema.user)
                    .set({ mustChangePassword: false })
                    .where(
                      and(
                        eq(schema.user.id, account.userId as string),
                        eq(schema.user.mustChangePassword, true)
                      )
                    )
                    .run()
                }
              } catch (err) {
                console.error('Failed to clear mustChangePassword:', err)
              }
            },
          },
        },
        session: {
          create: {
            after: async (session) => {
              try {
                const sessSettings = getSettings()
                const sessAuth = { ...DEFAULT_AUTH_SETTINGS, ...sessSettings.auth }
                enforceMaxConcurrentSessions(session.userId, sessAuth.maxConcurrentSessions ?? 5)
              } catch (err) {
                console.error('Failed to enforce max concurrent sessions:', err)
              }
            },
          },
        },
      },
    })
  }
  return _auth
}
