/**
 * Joining with a password from an invite link (team directories). The link
 * came in a Slack DM to the directory person an invited row was made for;
 * holding it lets them set a password on that row, which claims it. Signing
 * in with SSO claims it too, by email, without the link.
 *
 * Mounted at /api/auth/invite, behind the auth rate limit, and public: the
 * person has no session yet.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'
import { db } from '@shared/lib/db'
import { changesOf, insertWhere } from '@shared/lib/db/batch'
import { authAccount, user } from '@shared/lib/db/schema'
import { getAuthSettings, isPlatformControlledAuth } from '@shared/lib/auth/auth-settings'
import { readInviteToken } from '@shared/lib/auth/invite-tokens'
import { claimInvitedUser } from '@shared/lib/auth/claim-invited-user'
import { validatePasswordComplexity } from '../middleware/auth-enforcement'
import type { InviteDetails } from '@shared/lib/team-directory/invite-schema'

const router = new Hono()

const claimBodySchema = z.object({
  token: z.string().min(1).max(200),
  name: z.string().trim().min(1, 'Name is required').max(200),
  password: z.string().min(1, 'Password is required'),
})

const GONE = { error: 'This invitation has expired or was already used. Sign in instead, or ask for a new invitation.' }

async function passwordJoinAllowed(): Promise<boolean> {
  return !isPlatformControlledAuth() && (await getAuthSettings()).allowLocalAuth !== false
}

async function invitedUser(token: string) {
  const userId = await readInviteToken(token)
  if (!userId) return null
  const row = await db.select({ id: user.id, name: user.name, email: user.email, status: user.status, invitedBy: user.invitedByUserId })
    .from(user).where(eq(user.id, userId)).get()
  return row?.status === 'invited' ? row : null
}

// GET /api/auth/invite/:token - Who the invitation is for, so the join form can greet them.
router.get('/:token', async (c) => {
  c.header('Cache-Control', 'no-store')
  const invited = await invitedUser(c.req.param('token'))
  if (!invited) return c.json(GONE, 404)
  const inviter = invited.invitedBy
    ? await db.select({ name: user.name }).from(user).where(eq(user.id, invited.invitedBy)).get()
    : undefined
  const settings = await getAuthSettings()
  const details: InviteDetails = {
    name: invited.name,
    email: invited.email,
    invitedBy: inviter?.name ?? null,
    passwordJoin: await passwordJoinAllowed(),
    passwordMinLength: settings.passwordMinLength ?? 8,
    passwordRequireComplexity: settings.passwordRequireComplexity ?? false,
  }
  return c.json(details)
})

// POST /api/auth/invite/claim - Sets a password on the invited row, which joins them. They then sign in as usual.
router.post('/claim', async (c) => {
  c.header('Cache-Control', 'no-store')
  const parsed = claimBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  const { token, name, password } = parsed.data
  if (!(await passwordJoinAllowed())) return c.json({ error: 'Sign in with single sign-on to join.' }, 403)

  const settings = await getAuthSettings()
  const minLength = settings.passwordMinLength ?? 8
  const maxLength = settings.passwordMaxLength ?? 128
  if (password.length < minLength) return c.json({ error: `Password must be at least ${minLength} characters` }, 400)
  if (password.length > maxLength) return c.json({ error: `Password must be at most ${maxLength} characters` }, 400)
  const complexity = settings.passwordRequireComplexity ? validatePasswordComplexity(password) : null
  if (complexity) return c.json({ error: complexity }, 400)

  const invited = await invitedUser(token)
  if (!invited) return c.json(GONE, 404)

  const now = new Date()
  // One statement decides: the password goes on only while the row is still
  // invited and has none, so two claims (or a claim racing an SSO sign-in) can't both set one.
  const added = changesOf(await insertWhere(authAccount, {
    id: randomUUID(),
    accountId: invited.id,
    providerId: 'credential',
    userId: invited.id,
    password: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  }, sql`exists (select 1 from ${user} where ${user.id} = ${invited.id} and ${user.status} = 'invited')
    and not exists (select 1 from ${authAccount} where ${authAccount.userId} = ${invited.id} and ${authAccount.providerId} = 'credential')`).run())
  if (!added) return c.json(GONE, 410)

  await claimInvitedUser(invited.id)
  if (name !== invited.name) await db.update(user).set({ name, updatedAt: new Date() }).where(eq(user.id, invited.id)).run()
  const joined = await db.select({ banned: user.banned }).from(user).where(eq(user.id, invited.id)).get()
  // With admin approval on, they wait for it before they can sign in.
  return c.json({ email: invited.email, pendingApproval: joined?.banned === true })
})

export default router
