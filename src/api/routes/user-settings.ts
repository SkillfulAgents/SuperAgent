import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { getUserSettings, updateUserSettings } from '@shared/lib/services/user-settings-service'

const userSettingsRouter = new Hono()

userSettingsRouter.use('*', Authenticated())

// GET /api/user-settings - Get current user's settings
userSettingsRouter.get('/', (c) => {
  const userId = getCurrentUserId(c)
  const settings = getUserSettings(userId)
  return c.json(settings)
})

// PUT /api/user-settings - Update current user's settings
userSettingsRouter.put('/', async (c) => {
  const userId = getCurrentUserId(c)
  const body = await c.req.json()
  const updated = updateUserSettings(userId, body)
  return c.json(updated)
})

export default userSettingsRouter
