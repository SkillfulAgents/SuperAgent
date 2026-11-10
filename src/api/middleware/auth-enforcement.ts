import type { Context, Next } from 'hono'
import { sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { user } from '@shared/lib/db/schema'
import { getAuthSettings, isPlatformControlledAuth } from '@shared/lib/auth/auth-settings'
import { digestKeyPart, type StateKey } from '@shared/lib/app-state'
import { defineLockout, type LockoutPolicy, type LockoutRecord, type UnlockedStatus } from '@shared/lib/app-state/lockout'
import { captureException } from '@shared/lib/error-reporting'
import { invitedUserByEmail } from '@shared/lib/auth/claim-invited-user'
import { signUpInvitedUser } from './invited-sign-up'

/**
 * Failed email sign-ins per account, keyed by the lowercased email as sent
 * (digested). Failures below the threshold have no expiry: they last until a
 * successful sign-in clears them.
 */
const accountLockouts = defineLockout({ name: 'auth:lockout' })

function lockoutPolicy(authSettings: Awaited<ReturnType<typeof getAuthSettings>>): LockoutPolicy {
  return {
    threshold: authSettings.accountLockoutThreshold ?? 10,
    lockMs: (authSettings.accountLockoutDurationMin ?? 30) * 60 * 1000,
  }
}

export function validatePasswordComplexity(password: string): string | null {
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter'
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter'
  if (!/[0-9]/.test(password)) return 'Password must contain a number'
  if (!/[^a-zA-Z0-9]/.test(password)) return 'Password must contain a symbol'
  return null
}

/**
 * Auth enforcement middleware.
 * Intercepts signup, sign-in, and password-change requests to enforce
 * admin-configured auth settings (signup mode, password policy, lockout, etc.).
 */
export async function authEnforcementMiddleware(c: Context, next: Next) {
  if (c.req.method !== 'POST') return next()

  const authSettings = await getAuthSettings()
  const policy = lockoutPolicy(authSettings)
  // The sign-in's account and the lockout state it was let through with.
  let signIn: { key: StateKey<LockoutRecord, 'strong'>; status: UnlockedStatus } | null = null
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const path = new URL(c.req.url).pathname

  // Read body without consuming it (clone the request)
  let body: Record<string, unknown> | null = null
  try {
    const cloned = c.req.raw.clone()
    body = await cloned.json()
  } catch {
    // Not JSON or empty body — let Better Auth handle it
  }

  // --- Signup enforcement ---
  if (path === '/api/auth/sign-up/email') {
    // First-user bypass: allow the very first user to register regardless of settings
    // (needed to bootstrap the system — first user becomes admin). A platform-controlled
    // deployment has nothing to bootstrap: its members, owner included, come from Platform.
    let isFirstUser = false
    if (!isPlatformControlledAuth()) {
      try {
        const result = await db.select({ count: sql<number>`count(*)` }).from(user).get()
        isFirstUser = !result || result.count === 0
      } catch {
        // DB not ready — allow signup (Better Auth will handle it)
        isFirstUser = true
      }
    }

    if (!isFirstUser) {
      if (!authSettings.allowLocalAuth) {
        return c.json({ code: 'LOCAL_AUTH_DISABLED', message: 'Email authentication is disabled' }, 403)
      }

      // Someone shared an agent with this address, or mentioned it, before
      // they joined (team directories): that is their invitation.
      const invited = typeof body?.email === 'string' ? await invitedUserByEmail(body.email) : null

      const mode = authSettings.signupMode ?? 'invitation_only'
      if (mode === 'closed' || (mode === 'invitation_only' && !invited)) {
        return c.json({ code: 'SIGNUPS_DISABLED', message: 'Signups are currently disabled' }, 403)
      }

      if (mode === 'domain_restricted' && !invited && body?.email) {
        const email = String(body.email)
        const domain = email.split('@')[1]?.toLowerCase()
        const allowedDomains = (authSettings.allowedSignupDomains ?? []).map(d => d.toLowerCase())
        if (!domain || !allowedDomains.includes(domain)) {
          return c.json({ code: 'DOMAIN_NOT_ALLOWED', message: 'Signups from this email domain are not allowed' }, 403)
        }
      }

      // Password policy checks on signup
      if (body?.password) {
        const password = String(body.password)
        const minLen = authSettings.passwordMinLength ?? 12
        if (password.length < minLen) {
          return c.json({ code: 'WEAK_PASSWORD', message: `Password must be at least ${minLen} characters` }, 400)
        }
        if (authSettings.passwordRequireComplexity) {
          const error = validatePasswordComplexity(password)
          if (error) {
            return c.json({ code: 'WEAK_PASSWORD', message: error }, 400)
          }
        }
      }

      // Their account exists already: the sign-up claims it.
      if (invited && body) return signUpInvitedUser(c, invited, body, { passwordMaxLength: authSettings.passwordMaxLength ?? 128 })
    }
  }

  // --- Sign-in enforcement ---
  if (path === '/api/auth/sign-in/email') {
    if (!authSettings.allowLocalAuth) {
      return c.json({ code: 'LOCAL_AUTH_DISABLED', message: 'Email authentication is disabled' }, 403)
    }

    // Account lockout check. An AppState failure is thrown: a sign-in whose
    // lock cannot be read is refused, not let through.
    if (body?.email) {
      const email = String(body.email).toLowerCase()
      const key = accountLockouts.key(digestKeyPart(email))
      // Clears a lock that has run out, so the account starts counting again.
      const status = await accountLockouts.check(key, policy)

      if (status.locked) {
        const remainingMin = Math.max(1, Math.ceil((status.lockedUntil - Date.now()) / 60000))
        return c.json({
          code: 'ACCOUNT_LOCKED',
          message: `Account is locked. Try again in ${remainingMin} minute${remainingMin !== 1 ? 's' : ''}.`,
        }, 429)
      }
      signIn = { key, status }

      // Pre-check ban status so we return a meaningful message
      // instead of Better Auth's generic "No reason"
      try {
        const bannedUser = await db
          .select({ banned: user.banned, banReason: user.banReason })
          .from(user)
          .where(sql`lower(${user.email}) = ${email}`)
          .get()
        if (bannedUser?.banned) {
          const reason = bannedUser.banReason
          if (reason === 'Pending admin approval') {
            return c.json({
              code: 'PENDING_APPROVAL',
              message: 'Your account is pending admin approval. Please wait for an admin to activate your account.',
            }, 403)
          }
          return c.json({
            code: 'BANNED',
            message: 'Your account has been banned. Please contact an administrator.',
          }, 403)
        }
      } catch {
        // DB error — let Better Auth handle it
      }
    }
  }

  // --- Password change enforcement ---
  if (path === '/api/auth/change-password' && body?.newPassword) {
    const newPassword = String(body.newPassword)
    const minLen = authSettings.passwordMinLength ?? 12
    if (newPassword.length < minLen) {
      return c.json({ code: 'WEAK_PASSWORD', message: `Password must be at least ${minLen} characters` }, 400)
    }
    if (authSettings.passwordRequireComplexity) {
      const error = validatePasswordComplexity(newPassword)
      if (error) {
        return c.json({ code: 'WEAK_PASSWORD', message: error }, 400)
      }
    }
  }

  // Call next handler (Better Auth)
  await next()

  // After sign-in: count a failure toward the lockout, or clear the failures
  // this sign-in was checked against. Better Auth has answered by now, so a
  // lockout write that fails is reported and its answer stands: throwing
  // would replace it with a 500, and a success's session cookie with it.
  if (signIn) {
    try {
      if (c.res.status >= 400) {
        await accountLockouts.failed(signIn.key, policy)
      } else {
        // Failures counted after the check (a concurrent wrong password) stay.
        await accountLockouts.succeeded(signIn.key, signIn.status)
      }
    } catch (error) {
      console.error('[auth] Failed to update the account lockout:', error)
      captureException(error, { tags: { component: 'auth', operation: 'account-lockout' } })
    }
  }
}
