import fs from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { user } from '@shared/lib/db/schema'
import { bodyLimit } from 'hono/body-limit'
import { Authenticated } from '../middleware/auth'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { isAuthMode } from '@shared/lib/auth/mode'
import { avatarFilenameSchema, MAX_AVATAR_BYTES } from '@shared/lib/user-profile-schema'
import { avatarDirectory, InvalidAvatarError, setAvatar } from '@shared/lib/services/profile-avatar-service'

const profile = new Hono()
profile.use('*', async (c, next) => isAuthMode() ? next() : c.notFound())
profile.use('*', Authenticated())
profile.put('/avatar', bodyLimit({ maxSize: MAX_AVATAR_BYTES }), async (c) => {
  if (c.req.header('content-type')?.split(';')[0] !== 'image/png') {
    return c.json({ error: 'Choose a PNG image.' }, 415)
  }
  try {
    const avatarOverride = await setAvatar(getCurrentUserId(c), Buffer.from(await c.req.arrayBuffer()))
    return c.json({ avatarOverride })
  } catch (error) {
    if (error instanceof InvalidAvatarError) return c.json({ error: error.message }, 400)
    console.error('Failed to save profile photo', error)
    return c.json({ error: 'Could not save your photo. Please try again.' }, 500)
  }
})
profile.delete('/avatar', async (c) => {
  await setAvatar(getCurrentUserId(c), null)
  return c.json({ avatarOverride: null })
})
profile.get('/images/:filename', async (c) => {
  const filename = avatarFilenameSchema.safeParse(c.req.param('filename'))
  if (!filename.success) return c.notFound()
  // Only check existence so the avatar index covers the entire lookup.
  const activeAvatar = db.select({ exists: sql`1` }).from(user)
    .where(eq(user.avatarOverride, `/api/profile/images/${filename.data}`)).limit(1).get()
  if (!activeAvatar) return c.notFound()
  try {
    const bytes = await fs.readFile(path.join(avatarDirectory(), filename.data))
    c.header('Content-Type', 'image/png')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Cache-Control', 'private, max-age=31536000, immutable')
    return c.body(new Uint8Array(bytes))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return c.notFound()
    throw error
  }
})
export default profile
