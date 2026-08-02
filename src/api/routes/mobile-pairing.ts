import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { captureException } from '@shared/lib/error-reporting'
import {
  RedeemPairingRequestSchema,
  RenewMobileSessionRequestSchema,
} from '@shared/lib/auth/mobile-pairing-schema'

// Pairing requests are tiny JSON bodies (a token and a device label).
const MAX_JSON_BODY_BYTES = 16 * 1024

// Every response that can carry a credential is uncacheable. Tokens travel in
// JSON bodies only — the `set-auth-token` header is stripped on /api/auth/*.
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

/**
 * The one denial the redeem endpoint ever utters. Missing, expired, and
 * already-redeemed tokens must be indistinguishable, so every failure path
 * funnels through this exact response.
 */
function pairingDenied(c: Context) {
  return c.json({ error: 'invalid_pairing_token' }, 401, NO_STORE_HEADERS)
}

interface SessionInfo {
  session: {
    id: string
    userId: string
    expiresAt: Date
    creationMethod?: string | null
    deviceName?: string | null
  }
  user: { id: string; email: string; name: string }
}

/** The Better Auth session for this request (cookie or bearer), or null. */
async function getRequestSession(c: Context): Promise<SessionInfo | null> {
  const { getAuth } = await import('@shared/lib/auth/index')
  const session = await getAuth().api.getSession({ headers: c.req.raw.headers })
  // Widen: additional fields (creationMethod, deviceName) are persisted on the
  // row and returned by getSession, but not part of the base inferred type.
  return (session as SessionInfo | null) ?? null
}

/**
 * Mobile pairing endpoints — QR/deep-link pairing of the mobile app.
 * Mounted at /api/auth/mobile, before the Better Auth wildcard; the
 * /api/auth/* rate limiter and enforcement middleware apply.
 */
const mobilePairing = new Hono()

const limitBody = bodyLimit({
  maxSize: MAX_JSON_BODY_BYTES,
  onError: (c) => c.json({ error: 'Request body too large' }, 400, NO_STORE_HEADERS),
})

/**
 * POST /pairing-token — mint a short-lived single-use pairing token.
 *
 * Interactive sessions only: a session that itself arrived through a minted
 * token (token-exchange, mobile) must not be able to mint further credentials,
 * or one leaked token could fan out indefinitely.
 */
mobilePairing.post('/pairing-token', async (c) => {
  const info = await getRequestSession(c)
  if (!info) return c.json({ error: 'Unauthorized' }, 401, NO_STORE_HEADERS)
  const method = info.session.creationMethod
  if (method === 'token-exchange' || method === 'mobile') {
    return c.json({ error: 'Pairing requires an interactive session' }, 403, NO_STORE_HEADERS)
  }

  try {
    const { mintPairingToken } = await import('@shared/lib/auth/mobile-pairing')
    const { getAppBaseUrl } = await import('@shared/lib/auth/config')
    const { token, expiresAt } = mintPairingToken(info.user.id)
    return c.json(
      { token, expiresAt: expiresAt.toISOString(), deploymentUrl: getAppBaseUrl() },
      200,
      NO_STORE_HEADERS,
    )
  } catch (error) {
    captureException(error, { tags: { component: 'mobile-pairing', operation: 'mint' } })
    return c.json({ error: 'Internal server error' }, 500, NO_STORE_HEADERS)
  }
})

/**
 * POST /redeem — exchange a pairing token for a mobile session (public).
 * One uniform 401 for every bad token: missing, expired, and replayed are
 * indistinguishable by design.
 */
mobilePairing.post('/redeem', limitBody, async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return pairingDenied(c)
  }
  const parsed = RedeemPairingRequestSchema.safeParse(body)
  if (!parsed.success) return pairingDenied(c)

  const { redeemPairingToken, MobilePairingError } = await import('@shared/lib/auth/mobile-pairing')
  try {
    const result = await redeemPairingToken(parsed.data.token, {
      deviceName: parsed.data.deviceName,
      userAgent: c.req.header('user-agent'),
      ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
    })
    return c.json(result, 200, NO_STORE_HEADERS)
  } catch (error) {
    if (error instanceof MobilePairingError) return pairingDenied(c)
    captureException(error, { tags: { component: 'mobile-pairing', operation: 'redeem' } })
    return c.json({ error: 'Internal server error' }, 500, NO_STORE_HEADERS)
  }
})

/**
 * POST /renew — mint a fresh mobile session for the calling mobile session.
 * Gated to `creationMethod === 'mobile'`: a browser session renews by logging
 * in, not by minting installed-app credentials.
 */
mobilePairing.post('/renew', limitBody, async (c) => {
  const info = await getRequestSession(c)
  if (!info) return c.json({ error: 'Unauthorized' }, 401, NO_STORE_HEADERS)
  if (info.session.creationMethod !== 'mobile') {
    return c.json({ error: 'Only mobile sessions can renew' }, 403, NO_STORE_HEADERS)
  }

  let body: unknown = {}
  try {
    const raw = await c.req.text()
    if (raw) body = JSON.parse(raw)
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400, NO_STORE_HEADERS)
  }
  const parsed = RenewMobileSessionRequestSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400, NO_STORE_HEADERS)

  const { renewMobileSession, MobilePairingError } = await import('@shared/lib/auth/mobile-pairing')
  try {
    const result = await renewMobileSession(
      {
        id: info.session.id,
        userId: info.session.userId,
        expiresAt: new Date(info.session.expiresAt),
        deviceName: info.session.deviceName,
      },
      {
        deviceName: parsed.data.deviceName,
        purpose: parsed.data.purpose,
        userAgent: c.req.header('user-agent'),
        ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
      },
    )
    return c.json(result, 200, NO_STORE_HEADERS)
  } catch (error) {
    if (error instanceof MobilePairingError) {
      return c.json({ error: 'Unauthorized' }, 401, NO_STORE_HEADERS)
    }
    captureException(error, { tags: { component: 'mobile-pairing', operation: 'renew' } })
    return c.json({ error: 'Internal server error' }, 500, NO_STORE_HEADERS)
  }
})

/**
 * GET /devices — the caller's paired mobile devices. Own rows only; ids,
 * labels and timestamps — never token values.
 */
mobilePairing.get('/devices', async (c) => {
  const info = await getRequestSession(c)
  if (!info) return c.json({ error: 'Unauthorized' }, 401)

  const { listMobileDevices } = await import('@shared/lib/auth/mobile-pairing')
  const devices = listMobileDevices(info.user.id).map((device) => ({
    id: device.id,
    deviceName: device.deviceName,
    createdAt: new Date(device.createdAt).toISOString(),
    updatedAt: new Date(device.updatedAt).toISOString(),
    expiresAt: new Date(device.expiresAt).toISOString(),
    isCurrent: device.id === info.session.id,
  }))
  return c.json({ devices })
})

/**
 * DELETE /devices/:id — revoke one of the caller's paired mobile devices.
 * Someone else's session — or a non-mobile one — is a plain 404: this route
 * does not confirm foreign session ids exist.
 */
mobilePairing.delete('/devices/:id', async (c) => {
  const info = await getRequestSession(c)
  if (!info) return c.json({ error: 'Unauthorized' }, 401)

  const { revokeMobileDevice } = await import('@shared/lib/auth/mobile-pairing')
  const revoked = await revokeMobileDevice(info.user.id, c.req.param('id'))
  if (!revoked) return c.json({ error: 'Not found' }, 404)
  return c.json({ success: true })
})

export default mobilePairing
