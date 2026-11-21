import { createHmac, generateKeyPairSync } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import jwksRsa from 'jwks-rsa'
import { afterEach, expect, it, vi } from 'vitest'
import { createTeamsGatewayEndpoint } from '@shared/lib/chat-integrations/teams-relay-gateway-client'
import { createTeamsRelayGateway } from './teams-relay-gateway'

const scope = { tenantId: '2a0cb4f7-9280-485c-a201-150a802fd1ed', appId: '5caccb66-f3ff-42f9-af8c-410bfbadfb6c' }
const relayUrl = 'https://platform.test/v1/hooks/whep_queue'
const secret = 'b'.repeat(64)
const base = 'https://gateway.test/api/teams-relay'
const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' })
const activity = {
  type: 'invoke', name: 'adaptiveCard/action', serviceUrl: 'https://smba.trafficmanager.net/amer/',
  channelId: 'msteams', recipient: { id: `28:${scope.appId}` }, conversation: { tenantId: scope.tenantId },
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('discovers only the public key, seals the callback, and queues an SDK-verified activity before acknowledging the card', async () => {
  const gateway = createTeamsRelayGateway(jwk, 'https://platform.test')
  const routes = { ...scope, relayUrl, secret }
  const queued = vi.fn(async (_target: string, _request?: RequestInit) => new Response(null, { status: 202 }))
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string, options?: RequestInit) => {
    if (String(input) === base + '/key') return gateway.request('/key')
    return queued(String(input), options)
  }))
  const publicKey = await (await gateway.request('/key')).json()
  expect(publicKey).toMatchObject({ kty: 'EC', crv: 'P-256' })
  expect(publicKey).not.toHaveProperty('d')
  const url = await createTeamsGatewayEndpoint(base, routes)
  expect(url).not.toContain(secret)
  expect(url).not.toContain(scope.tenantId)

  const pair = await generateKeyPair('RS256', { extractable: true })
  vi.spyOn(jwksRsa.JwksClient.prototype, 'getKeys').mockResolvedValue([{ ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256', use: 'sig' }])
  const bearer = 'Bearer ' + await new SignJWT({ serviceurl: activity.serviceUrl }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer('https://api.botframework.com').setAudience(scope.appId).setNotBefore('0s').setExpirationTime('5m').sign(pair.privateKey)
  const path = (endpoint: string) => endpoint.slice(base.length)
  const post = (endpoint: string, body: unknown, auth = bearer) => gateway.request(path(endpoint), {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  expect((await post(url, activity, '')).status).toBe(401)
  expect((await post(url, activity, 'Bearer missing')).status).toBe(401)
  expect((await post(url, { ...activity, conversation: { tenantId: scope.appId } })).status).toBe(401)
  const wrongHost = await createTeamsGatewayEndpoint(base, { ...routes, relayUrl: 'https://other.test/v1/hooks/whep_queue' })
  expect((await post(wrongHost, activity)).status).toBe(404)
  const wrongPath = await createTeamsGatewayEndpoint(base, { ...routes, relayUrl: 'https://platform.test/v1/something-else' })
  expect((await post(wrongPath, activity)).status).toBe(404)
  expect((await post(url, { ...activity, name: 'unknownAction' })).status).toBe(501)
  expect(queued).not.toHaveBeenCalled()
  const reply = await post(url, activity)
  expect(reply.status).toBe(200)
  expect(await reply.json()).toMatchObject({ statusCode: 200, value: expect.stringContaining('for processing') })
  const [destination, request] = queued.mock.calls[0]
  expect(destination).toBe(relayUrl)
  expect(Buffer.from(request!.body as ArrayBuffer).toString()).toBe(JSON.stringify(activity))
  const headers = new Headers(request!.headers)
  expect(headers.get('authorization')).toBeNull()
  expect(headers.get('x-gamut-teams-signature')).toBe(createHmac('sha256', secret).update(JSON.stringify(activity)).digest('hex'))
  expect(request?.redirect).toBe('error')
  queued.mockResolvedValueOnce(new Response(null, { status: 429 }))
  expect((await post(url, activity)).status).toBe(503)
  const fileConsent = await post(url, { ...activity, name: 'fileConsent/invoke' })
  expect(fileConsent.status).toBe(200)
  expect(await fileConsent.text()).toBe('')
})

it('rejects an invalid allowlist, an unreadable key, and an oversized request before Microsoft or the relay is contacted', async () => {
  expect(() => createTeamsRelayGateway(jwk, 'http://platform.test')).toThrow('HTTPS origin')
  const gateway = createTeamsRelayGateway(jwk, 'https://platform.test')
  const fetch = vi.fn(async () => Response.json({ d: 'invalid' }))
  vi.stubGlobal('fetch', fetch)
  await expect(createTeamsGatewayEndpoint(base, { ...scope, relayUrl, secret })).rejects.toThrow('gateway key')
  const oversized = await gateway.request('/messages/token', { method: 'POST', headers: { 'content-length': '1048577' }, body: 'x' })
  expect(oversized.status).toBe(413)
  expect(fetch).toHaveBeenCalledTimes(1)
})
