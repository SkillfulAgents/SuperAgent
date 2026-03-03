import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { Authenticated, IsAdmin } from '../middleware/auth'
import { db } from '@shared/lib/db'
import { user, authAccount } from '@shared/lib/db/schema'
const adminUsersRouter = new Hono()
adminUsersRouter.use('*', Authenticated(), IsAdmin())

// POST /api/admin/users/invite - Create user with mustChangePassword=true
adminUsersRouter.post('/invite', async (c) => {
  const body = await c.req.json<{ name: string; email: string; password: string; role?: string }>()
  const { name, email, password, role } = body

  if (!name?.trim() || !email?.trim() || !password) {
    return c.json({ error: 'name, email, and password are required' }, 400)
  }

  const trimmedEmail = email.trim().toLowerCase()
  const trimmedName = name.trim()

  // Check if email already exists
  const existing = db.select({ id: user.id }).from(user).where(eq(user.email, trimmedEmail)).get()
  if (existing) {
    return c.json({ error: 'A user with this email already exists' }, 400)
  }

  try {
    const { hashPassword } = await import('better-auth/crypto')
    const userId = crypto.randomUUID()
    const hashedPassword = await hashPassword(password)
    const now = new Date()

    // Create user with mustChangePassword flag
    db.insert(user).values({
      id: userId,
      name: trimmedName,
      email: trimmedEmail,
      role: role || 'user',
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now,
    }).run()

    // Create credential account with hashed password
    db.insert(authAccount).values({
      id: crypto.randomUUID(),
      accountId: userId,
      providerId: 'credential',
      userId,
      password: hashedPassword,
      createdAt: now,
      updatedAt: now,
    }).run()

    return c.json({ user: { id: userId, name: trimmedName, email: trimmedEmail } })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to create user'
    return c.json({ error: message }, 400)
  }
})

// POST /api/admin/users/reset-password - Reset user password with mustChangePassword=true
adminUsersRouter.post('/reset-password', async (c) => {
  const body = await c.req.json<{ userId: string; password: string }>()
  const { userId, password } = body

  if (!userId?.trim() || !password) {
    return c.json({ error: 'userId and password are required' }, 400)
  }

  // Verify the target user exists
  const targetUser = db.select({ id: user.id }).from(user).where(eq(user.id, userId)).get()
  if (!targetUser) {
    return c.json({ error: 'User not found' }, 404)
  }

  // Verify the target user has a credential account
  const credentialAccount = db
    .select({ id: authAccount.id })
    .from(authAccount)
    .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')))
    .get()
  if (!credentialAccount) {
    return c.json({ error: 'User does not have a credential account' }, 400)
  }

  try {
    const { hashPassword } = await import('better-auth/crypto')
    const hashedPassword = await hashPassword(password)

    db.update(authAccount)
      .set({ password: hashedPassword })
      .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')))
      .run()

    db.update(user)
      .set({ mustChangePassword: true })
      .where(eq(user.id, userId))
      .run()

    return c.json({ success: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to reset password'
    return c.json({ error: message }, 500)
  }
})

export default adminUsersRouter
