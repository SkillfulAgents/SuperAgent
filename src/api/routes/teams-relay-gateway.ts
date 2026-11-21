import { createHmac, createPrivateKey, createPublicKey } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { compactDecrypt } from 'jose'
import { z } from 'zod'
import { gatewayPrivateKey, gatewayPublicKey, gatewayRoute } from '@shared/lib/chat-integrations/teams-relay-gateway-client'

const relayIdentity = z.object({ type: z.string(), name: z.string().optional() })

/** Only this deployment's platform hook origin can receive a Microsoft-verified activity. */
function hookOrigin(raw: string): string {
  const url = URL.parse(raw)
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('TEAMS_RELAY_HOOK_ORIGIN must be the HTTPS origin of the Gamut webhook relay.')
  }
  return url.origin
}

export function createTeamsRelayGateway(privateJwk: unknown, allowedHookOrigin: string) {
  const origin = hookOrigin(allowedHookOrigin)
  const key = createPrivateKey({ key: gatewayPrivateKey.parse(privateJwk), format: 'jwk' })
  const publicKey = gatewayPublicKey.parse(createPublicKey(key).export({ format: 'jwk' }))
  const router = new Hono()
  router.get('/key', c => c.json(publicKey))
  router.post('/messages/:binding', bodyLimit({ maxSize: 1024 * 1024 }), async c => {
    const authorization = c.req.header('Authorization')
    if (!authorization || !/^Bearer [^\s]+$/i.test(authorization)) return c.body(null, 401)
    const token = c.req.param('binding')
    if (token.length > 2048) return c.body(null, 404)
    let binding: z.infer<typeof gatewayRoute>
    try {
      const { plaintext } = await compactDecrypt(token, key, {
        keyManagementAlgorithms: ['ECDH-ES'], contentEncryptionAlgorithms: ['A256GCM'],
      })
      binding = gatewayRoute.parse(JSON.parse(new TextDecoder().decode(plaintext)))
    } catch {
      return c.body(null, 404)
    }
    const target = URL.parse(binding.relayUrl)
    if (!target || target.origin !== origin || target.username || target.password || target.search || target.hash
      || !/^\/v1\/hooks\/whep_[A-Za-z0-9_-]+$/.test(target.pathname)) return c.body(null, 404)

    const bytes = await c.req.arrayBuffer()
    let activity: unknown
    try {
      activity = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      return c.body(null, 400)
    }
    try {
      const { verifyTeamsActivity } = await import('@shared/lib/chat-integrations/teams-api')
      await verifyTeamsActivity(authorization, activity, binding)
    } catch {
      return c.body(null, 401)
    }
    const kind = relayIdentity.safeParse(activity)
    if (!kind.success) return c.body(null, 400)
    if (kind.data.type === 'invoke' && !['adaptiveCard/action', 'fileConsent/invoke'].includes(kind.data.name ?? '')) {
      return c.body(null, 501)
    }

    // The relay can hold events while Gamut is offline. Only the verified bytes cross this boundary.
    const signature = createHmac('sha256', binding.secret).update(new Uint8Array(bytes)).digest('hex')
    let queued: Response
    try {
      queued = await fetch(target, {
        method: 'POST', body: bytes, redirect: 'error', signal: AbortSignal.timeout(3500),
        headers: { 'Content-Type': 'application/json', 'X-Gamut-Teams-Signature': signature },
      })
      await queued.body?.cancel()
    } catch {
      return c.body(null, 503)
    }
    if (!queued.ok) return c.body(null, 503)
    if (kind.data.type === 'invoke' && kind.data.name === 'adaptiveCard/action') {
      return c.json({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: 'Gamut received your response for processing.' })
    }
    return c.body(null, 200)
  })
  return router
}
