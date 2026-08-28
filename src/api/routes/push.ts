/**
 * Web Push subscription API
 *
 * Devices (installed PWAs) register their PushSubscription here; the
 * WebPushChannel delivers to every stored row. See
 * src/shared/lib/notifications/channels/web-push-channel.ts.
 */

import { Hono } from 'hono'
import { getViewerUserId } from '@shared/lib/auth/ownership'
import { getOrCreateVapidKeys } from '@shared/lib/notifications/push/vapid-keys'
import {
  upsertPushSubscription,
  deletePushSubscriptionByEndpoint,
} from '@shared/lib/notifications/push/push-subscription-service'
import {
  pushSubscribeRequestSchema,
  pushUnsubscribeRequestSchema,
} from '@shared/lib/notifications/push/push-subscription-schema'
import {
  upsertApnsDevice,
  deleteApnsDeviceByToken,
} from '@shared/lib/notifications/push/apns-device-service'
import { apnsDeviceRegisterRequestSchema } from '@shared/lib/notifications/push/apns-device-schema'
import { Authenticated, getRequestDeviceId } from '../middleware/auth'

const pushRouter = new Hono()

pushRouter.use('*', Authenticated())

// GET /api/push/vapid-public-key - the applicationServerKey for pushManager.subscribe()
pushRouter.get('/vapid-public-key', (c) => {
  const { publicKey } = getOrCreateVapidKeys()
  return c.json({ publicKey })
})

// POST /api/push/subscriptions - register/refresh this device's subscription (upsert by endpoint)
pushRouter.post('/subscriptions', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = pushSubscribeRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid subscription payload' }, 400)
  }

  // Owner of the subscription row: user id in auth mode (Authenticated()
  // guarantees the context user), null for the single local user.
  const ownerUserId = getViewerUserId(c)

  const { subscription, origin, deviceName } = parsed.data
  const stored = upsertPushSubscription({
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    origin,
    userId: ownerUserId,
    deviceName: deviceName ?? null,
  })
  if (!stored) {
    return c.json({ error: 'Too many push subscriptions for this account' }, 429)
  }

  return c.json({ success: true })
})

// DELETE /api/push/subscriptions - remove this device's subscription (scoped to its owner)
pushRouter.delete('/subscriptions', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = pushUnsubscribeRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid unsubscribe payload' }, 400)
  }

  const deleted = deletePushSubscriptionByEndpoint(
    parsed.data.endpoint,
    getViewerUserId(c) ?? undefined
  )
  if (!deleted) {
    return c.json({ error: 'Subscription not found' }, 404)
  }
  return c.body(null, 204)
})

// POST /api/push/devices - register/refresh this native device's APNs token
// (upsert by token; ApnsRelayChannel delivers to every stored row)
pushRouter.post('/devices', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = apnsDeviceRegisterRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid device payload' }, 400)
  }

  // Owner of the device row: user id in auth mode (Authenticated() guarantees
  // the context user), null for the single local user. The mobile device
  // family id ties the token to pairing so origin-device alert routing works;
  // null for non-mobile sessions.
  const ownerUserId = getViewerUserId(c)
  const mobileDeviceId = getRequestDeviceId(c)

  const { token, environment, platform, deviceName, workspaceTag } = parsed.data
  const stored = upsertApnsDevice({
    token: token.toLowerCase(),
    environment,
    userId: ownerUserId,
    mobileDeviceId,
    workspaceTag: workspaceTag ?? null,
    deviceName: deviceName ?? null,
    platform,
  })
  if (!stored) {
    return c.json({ error: 'Too many registered devices for this account' }, 429)
  }

  return c.json({ success: true })
})

// DELETE /api/push/devices/:token - remove this device's registration (scoped to its owner)
pushRouter.delete('/devices/:token', (c) => {
  const deleted = deleteApnsDeviceByToken(
    c.req.param('token').toLowerCase(),
    getViewerUserId(c) ?? undefined
  )
  if (!deleted) {
    return c.json({ error: 'Device not found' }, 404)
  }
  return c.body(null, 204)
})

export default pushRouter
