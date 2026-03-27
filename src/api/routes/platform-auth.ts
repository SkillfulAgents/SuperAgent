import { Hono } from 'hono'

import { Authenticated } from '../middleware/auth'
import { buildPlatformLoginUrl, getPlatformBaseUrl } from '@shared/lib/platform-auth/config'
import {
  getOrCreatePlatformClientInstanceId,
  getPlatformDeviceName,
} from '@shared/lib/services/platform-device-service'
import {
  clearPlatformAuth,
  getPlatformAuthStatus,
  savePlatformAuth,
} from '@shared/lib/services/platform-auth-service'

const platformAuth = new Hono()

platformAuth.use('*', Authenticated())

platformAuth.get('/', (c) => {
  return c.json({
    ...getPlatformAuthStatus(),
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
  const body = await c.req.json<{
    token?: string
    email?: string | null
    label?: string | null
    orgName?: string | null
    role?: string | null
  }>()

  if (!body.token?.trim()) {
    return c.json({ error: 'Missing token' }, 400)
  }

  const status = savePlatformAuth({
    token: body.token,
    email: body.email,
    label: body.label,
    orgName: body.orgName,
    role: body.role,
  })

  return c.json(status)
})

platformAuth.delete('/', (c) => {
  clearPlatformAuth()
  return c.json({
    ...getPlatformAuthStatus(),
    platformBaseUrl: getPlatformBaseUrl(),
  })
})

export default platformAuth
