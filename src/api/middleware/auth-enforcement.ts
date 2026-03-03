import type { Context, Next } from 'hono'
import { sql } from 'drizzle-orm'
import { getSettings, DEFAULT_AUTH_SETTINGS, type AuthSettings } from '@shared/lib/config/settings'
import { db } from '@shared/lib/db'
import { user } from '@shared/lib/db/schema'

// Per-email failed login attempt tracking
const accountLockouts = new Map<string, { count: number; lockedUntil: number }>()

/** Exported for testing: clear all lockout state */
export function clearLockouts() {
  accountLockouts.clear()
}

export function getAuthSettings(): AuthSettings {
  const settings = getSettings()
  return { ...DEFAULT_AUTH_SETTINGS, ...settings.auth }
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

  const authSettings = getAuthSettings()
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
    // (needed to bootstrap the system — first user becomes admin)
    let isFirstUser = false
    try {
      const result = db.select({ count: sql<number>`count(*)` }).from(user).get()
      isFirstUser = !result || result.count === 0
    } catch {
      // DB not ready — allow signup (Better Auth will handle it)
      isFirstUser = true
    }

    if (!isFirstUser) {
      if (!authSettings.allowLocalAuth) {
        return c.json({ code: 'LOCAL_AUTH_DISABLED', message: 'Email authentication is disabled' }, 403)
      }

      const mode = authSettings.signupMode ?? 'invitation_only'
      if (mode === 'closed' || mode === 'invitation_only') {
        return c.json({ code: 'SIGNUPS_DISABLED', message: 'Signups are currently disabled' }, 403)
      }

      if (mode === 'domain_restricted' && body?.email) {
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
    }
  }

  // --- Sign-in enforcement ---
  if (path === '/api/auth/sign-in/email') {
    if (!authSettings.allowLocalAuth) {
      return c.json({ code: 'LOCAL_AUTH_DISABLED', message: 'Email authentication is disabled' }, 403)
    }

    // Account lockout check
    if (body?.email) {
      const email = String(body.email).toLowerCase()
      const lockout = accountLockouts.get(email)
      const now = Date.now()

      if (lockout && lockout.count >= (authSettings.accountLockoutThreshold ?? 10)) {
        if (now < lockout.lockedUntil) {
          const remainingMin = Math.ceil((lockout.lockedUntil - now) / 60000)
          return c.json({
            code: 'ACCOUNT_LOCKED',
            message: `Account is locked. Try again in ${remainingMin} minute${remainingMin !== 1 ? 's' : ''}.`,
          }, 429)
        }
        // Lockout expired — reset
        accountLockouts.delete(email)
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

  // After sign-in: track failed/successful attempts for lockout
  if (path === '/api/auth/sign-in/email' && body?.email) {
    const email = String(body.email).toLowerCase()
    const status = c.res.status

    if (status >= 400) {
      // Failed login — increment counter
      const lockout = accountLockouts.get(email) ?? { count: 0, lockedUntil: 0 }
      lockout.count++
      const threshold = authSettings.accountLockoutThreshold ?? 10
      if (lockout.count >= threshold) {
        const durationMs = (authSettings.accountLockoutDurationMin ?? 30) * 60 * 1000
        lockout.lockedUntil = Date.now() + durationMs
      }
      accountLockouts.set(email, lockout)
    } else {
      // Successful login — clear lockout
      accountLockouts.delete(email)
    }
  }
}
