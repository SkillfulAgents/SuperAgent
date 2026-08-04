import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, bearer, genericOAuth } from 'better-auth/plugins'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import * as schema from '@shared/lib/db/schema'
import { getOrCreateAuthSecret } from './secret'
import { getAppBaseUrl, getTrustedOrigins } from './config'
import { getSettings } from '@shared/lib/config/settings'
import { resolveAuthSettings } from './auth-settings'
import { PENDING_APPROVAL_BAN_REASON } from './clear-pending-approval-bans'
import { enforceMaxConcurrentSessions } from './session-enforcement'
import { auditSessionCreated, resolveSessionCreationMethod } from './session-audit'
import { getGenericOAuthProviderConfigs } from './provider-config'

// Re-export isAuthMode from its own file (no better-auth imports)
// so consumers that only need the check don't pull in ESM deps.
export { isAuthMode } from './mode'

// Lazy singleton for the Better Auth instance.
// Typed via createAuthInstance so the concrete plugin/option inference is
// preserved (betterAuth's generic default is not assignable since 1.6).
let _auth: ReturnType<typeof createAuthInstance> | null = null

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
    _auth = createAuthInstance()
  }
  return _auth
}

function createAuthInstance() {
  const trustedOrigins = getTrustedOrigins()
  const settings = getSettings()
  const authSettings = resolveAuthSettings(settings.auth)
  const oauthProviders = getGenericOAuthProviderConfigs()
  const oauthPlugin = oauthProviders.length > 0
    ? genericOAuth({
        config: oauthProviders,
      })
    : null

  return betterAuth({
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
    account: {
      accountLinking: {
        // Keep pre-1.6.11 behavior: OAuth sign-in with a matching email
        // auto-links to the local account even if its email is unverified.
        // This app does not require email verification, so the hardened
        // default would stop OAuth/password accounts from merging.
        // The option is deprecated upstream and the secure gate becomes
        // unconditional in the next minor — revisit before moving past 1.6.
        requireLocalEmailVerified: false,
      },
    },
    session: {
      expiresIn: (authSettings.sessionMaxLifetimeHrs ?? 24) * 3600,
      updateAge: (authSettings.sessionIdleTimeoutMin ?? 60) * 60,
      additionalFields: {
        // Persisted so the answer survives the request that created the
        // session: the concurrent-session cap has to recognize an installed
        // client's session on a LATER login, when no endpoint context or
        // async-local tag exists any more.
        //
        // `input: false` — server-derived, never settable by a client.
        creationMethod: {
          type: 'string',
          required: false,
          input: false,
        },
      },
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
      // Accepts the session token via `Authorization: Bearer` so non-browser
      // clients (desktop app, watch) can call Authenticated() routes.
      bearer(),
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
              // Fresh settings each time; platform-controlled forces approval off.
              const currentAuth = resolveAuthSettings(getSettings().auth)
              if (result.changes === 0 && currentAuth.requireAdminApproval) {
                db.update(schema.user)
                  .set({ banned: true, banReason: PENDING_APPROVAL_BAN_REASON })
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
          before: async (session, context) => {
            // Stamp how this session came to exist onto the row itself. The
            // signals it is derived from — the endpoint path on the context,
            // the async-local tag set by the token exchange — exist only for
            // the duration of this call, so anything that needs the answer
            // later needs it written down now.
            //
            // Returning `{ data }` merges into the row about to be created.
            // Never throw: refusing to label a session must not stop it being
            // created, and an unlabelled session degrades to "capped", which
            // is exactly the old behaviour.
            try {
              return {
                data: {
                  ...session,
                  creationMethod: resolveSessionCreationMethod(session, context?.path),
                },
              }
            } catch (err) {
              console.error('Failed to resolve session creation method:', err)
              return
            }
          },
          after: async (session, context) => {
            try {
              const sessAuth = resolveAuthSettings(getSettings().auth)
              enforceMaxConcurrentSessions(session.userId, sessAuth.maxConcurrentSessions ?? 5)
            } catch (err) {
              console.error('Failed to enforce max concurrent sessions:', err)
            }
            // Every session-creation path lands here — browser password login,
            // platform OIDC, admin impersonation, and the RFC 7523 token
            // exchange — so one audit row per session comes from one place.
            // Its own try/catch: enforcement failing must not swallow the
            // record of the credential that was just issued.
            try {
              // Declared as GenericEndpointContext, but the object Better Auth
              // actually stores is a Partial — outside an endpoint it is null,
              // and `path` can be absent even when it is not.
              await auditSessionCreated(session, context?.path)
            } catch (err) {
              console.error('Failed to audit session creation:', err)
            }
          },
        },
      },
    },
  })
}
