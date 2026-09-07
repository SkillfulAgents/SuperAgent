import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { getCurrentUserId } from '@shared/lib/auth/config'
import {
  agentFolderSettingsWriteSchema,
  getUserSettings,
  updateUserSettings,
  userVoiceSettingsWriteSchema,
} from '@shared/lib/services/user-settings-service'
import { getConfiguredSttProvider } from '@shared/lib/stt'

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
  // The stored schema is read-tolerant for the folder fields — it drops what
  // it cannot parse instead of failing — so a malformed write would silently
  // erase the field it targets. Reject it here instead.
  const folderFields = agentFolderSettingsWriteSchema.safeParse(body)
  if (!folderFields.success) {
    return c.json({ error: 'Invalid agent folder settings' }, 400)
  }
  // Same for the voice fields: the stored schema drops what it cannot parse.
  const voiceFields = userVoiceSettingsWriteSchema.safeParse(body)
  if (!voiceFields.success) {
    return c.json({ error: 'Invalid voice settings' }, 400)
  }
  // Which voice ids exist is the configured provider's business.
  const ttsVoice = voiceFields.data.voice?.ttsVoice
  if (ttsVoice && !getConfiguredSttProvider()?.hasTtsVoice(ttsVoice)) {
    return c.json({ error: 'Unknown text-to-speech voice' }, 400)
  }
  const updated = updateUserSettings(userId, body)
  return c.json(updated)
})

export default userSettingsRouter
