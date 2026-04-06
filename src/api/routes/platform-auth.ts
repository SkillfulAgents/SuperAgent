import { Hono } from 'hono'

import { Authenticated } from '../middleware/auth'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { buildPlatformLoginUrl, getPlatformBaseUrl } from '@shared/lib/platform-auth/config'
import {
  getOrCreatePlatformClientInstanceId,
  getPlatformDeviceName,
} from '@shared/lib/services/platform-device-service'
import {
  getPlatformAuthStatus,
  savePlatformAuth,
  revokePlatformToken,
} from '@shared/lib/services/platform-auth-service'

const platformAuth = new Hono()

platformAuth.use('*', Authenticated())

platformAuth.get('/', (c) => {
  const userId = getCurrentUserId(c)
  return c.json({
    ...getPlatformAuthStatus(userId),
    platformBaseUrl: getPlatformBaseUrl(),
  })
})

platformAuth.post('/initiate', (c) => {
  const protocol = process.env.SUPERAGENT_PROTOCOL || 'superagent'
  const clientInstanceId = getOrCreatePlatformClientInstanceId()
  const deviceName = getPlatformDeviceName()

  return c.json({
    loginUrl: buildPlatformLoginUrl(protocol, {
      clientInstanceId,
      deviceName,
    }),
    platformBaseUrl: getPlatformBaseUrl(),
  })
})

platformAuth.post('/complete', async (c) => {
  const userId = getCurrentUserId(c)
  const body = await c.req.json<{
    token?: string
    email?: string | null
    label?: string | null
    orgId?: string | null
    orgName?: string | null
    role?: string | null
  }>()

  if (!body.token?.trim()) {
    return c.json({ error: 'Missing token' }, 400)
  }

  const status = savePlatformAuth(userId, {
    token: body.token,
    email: body.email,
    label: body.label,
    orgId: body.orgId,
    orgName: body.orgName,
    role: body.role,
  })

  return c.json(status)
})

platformAuth.post('/revoke', async (c) => {
  const body = await c.req.json<{ clearLocal?: boolean }>().catch(() => ({} as { clearLocal?: boolean }))
  const success = await revokePlatformToken({ clearLocal: body.clearLocal })
  return c.json({ success })
})

export default platformAuth
