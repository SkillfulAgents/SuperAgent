/**
 * Signing up with the email of someone invited from a team directory. Their
 * account already exists (they were shared with or mentioned before they
 * joined), so instead of making a user, the sign-up sets the password on it
 * and claims it, then signs in as Better Auth's sign-up would have. Owning the
 * email isn't checked, as for any sign-up here.
 */
import type { Context } from 'hono'
import { claimInvitedUserWithPassword } from '@shared/lib/auth/claim-invited-user'

export async function signUpInvitedUser(
  c: Context,
  invited: { id: string; email: string },
  body: Record<string, unknown>,
  limits: { passwordMaxLength: number },
): Promise<Response> {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!name || !password) return c.json({ code: 'INVALID_REQUEST', message: 'Name and password are required' }, 400)
  if (password.length > limits.passwordMaxLength) {
    return c.json({ code: 'WEAK_PASSWORD', message: `Password must be at most ${limits.passwordMaxLength} characters` }, 400)
  }
  if (!(await claimInvitedUserWithPassword(invited.id, { name, password }))) {
    return c.json({ code: 'USER_ALREADY_EXISTS', message: 'An account with this email already exists. Sign in instead.' }, 422)
  }
  // The session, as sign-up's own sign-in makes it; with admin approval on, this answers that they're banned, pending approval.
  const headers = new Headers(c.req.raw.headers)
  headers.delete('content-length')
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const signIn = new Request(new URL('/api/auth/sign-in/email', c.req.url), { method: 'POST', headers, body: JSON.stringify({ email: invited.email, password }) })
  const { handleAuthRequest } = await import('@shared/lib/auth/handler')
  return handleAuthRequest(signIn)
}
