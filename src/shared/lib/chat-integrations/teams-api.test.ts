import { createRequire } from 'node:module'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import jwksRsa from 'jwks-rsa'
import { afterEach, expect, it, vi } from 'vitest'
import { TeamsApi, teamsActivityIdentity } from './teams-api'
import { teamsConfigSchema, mergeChatIntegrationConfig } from './config-schema'
import { chatProviderSetup } from './setup'
import { prepareIntegrationSetup } from '../agent-integrations/setup'
import * as relayTransport from '../agent-integrations/relay-transport'
import { getWebhookRelay } from '../webhook-relay'
import { generateKeyPairSync } from 'node:crypto'

const config = teamsConfigSchema.parse({
  tenantId: '1a28ec10-35ca-4964-bd12-c23707e227ae',
  appId: '71722748-68a4-41d1-9fea-dfd68df19bf7',
  clientSecret: 'unit-test-secret',
})
const serviceUrl = 'https://smba.trafficmanager.net/amer/'
const activity = {
  channelId: 'msteams', serviceUrl, conversation: { tenantId: config.tenantId },
  recipient: { id: `28:${config.appId}` }, channelData: { tenant: { id: config.tenantId } },
}
const context = { agentSlug: 'agent', callbackUrl: 'https://host.test/callback' }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('validates a Microsoft SDK signature, time window, app audience, tenant, and service URL', async () => {
  const trusted = await generateKeyPair('RS256', { extractable: true })
  const other = await generateKeyPair('RS256')
  const key = { ...await exportJWK(trusted.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }
  vi.spyOn(jwksRsa.JwksClient.prototype, 'getKeys').mockResolvedValue([key])
  const now = Math.floor(Date.now() / 1000)
  const claims = { iss: 'https://api.botframework.com', aud: config.appId, serviceurl: serviceUrl, nbf: now - 5, exp: now + 600 }
  const sign = async (p = claims, signer = trusted.privateKey) => `Bearer ${await new SignJWT(p).setProtectedHeader({ alg: 'RS256', kid: key.kid }).sign(signer)}`
  const api = new TeamsApi(config)
  const signed = await sign()
  await expect(api.authenticate(signed, activity)).resolves.toBeUndefined()
  await expect(api.authenticate(await sign(claims, other.privateKey), activity)).rejects.toThrow()
  await expect(api.authenticate(await sign({ ...claims, nbf: now - 3000, exp: now - 1000 }), activity)).rejects.toThrow()
  await expect(api.authenticate(await sign({ ...claims, aud: config.tenantId }), activity)).rejects.toThrow()
  await expect(api.authenticate(await sign({ ...claims, iss: 'https://login.microsoftonline.com/' }), activity)).rejects.toThrow()
  await expect(api.authenticate(signed, { ...activity, serviceUrl: 'https://smba.trafficmanager.net/emea/' })).rejects.toThrow()
  await expect(api.authenticate(signed, { ...activity, recipient: { id: config.tenantId } })).rejects.toThrow()
  expect(teamsActivityIdentity({ ...activity, conversation: { tenantId: config.appId } })).toBeNull()
})

it('uses single-tenant client credentials, caches a token per bot, and never exposes an authentication error body', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ token_type: 'Bearer', access_token: 'bot-token', expires_in: 3600 }))
    .mockResolvedValueOnce(Response.json({ error_description: 'sensitive-detail' }, { status: 401 }))
  vi.stubGlobal('fetch', fetch)
  const api = new TeamsApi(config)
  await Promise.all([api.checkCredentials(), api.checkCredentials()])
  await api.checkCredentials()
  expect(fetch).toHaveBeenCalledTimes(1)
  const [url, options] = fetch.mock.calls[0]
  expect(url).toBe(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`)
  expect(Object.fromEntries(options!.body as URLSearchParams)).toEqual({
    client_id: config.appId, client_secret: config.clientSecret, grant_type: 'client_credentials', scope: 'https://api.botframework.com/.default',
  })
  await expect(new TeamsApi(config).checkCredentials()).rejects.toThrow('Microsoft token request failed (HTTP 401)')
})

it('only sends an inline image token to the Teams attachment endpoint', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ token_type: 'Bearer', access_token: 'image-token', expires_in: 7200 }))
    .mockResolvedValueOnce(new Response('image body'))
  vi.stubGlobal('fetch', fetch)
  const api = new TeamsApi(config)
  await expect(api.fetchInlineImage('https://unrelated.example/amer/v3/attachments/id/views/original')).rejects.toThrow()
  await expect(api.fetchInlineImage(serviceUrl + 'other')).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
  const url = serviceUrl + 'v3/attachments/imageid/views/original'
  expect(await (await api.fetchInlineImage(url)).text()).toBe('image body')
  expect(fetch).toHaveBeenLastCalledWith(url, expect.objectContaining({ headers: { Authorization: 'Bearer image-token' }, redirect: 'error' }))
})

it('supplies the SDK token for messages, thread replies, updates, typing and reactions and restricts the destination', async () => {
  type Axios = typeof import('axios').default
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@microsoft/teams.common'))
  const axios = sdkRequire('axios') as Axios
  const http = vi.fn<import('axios').AxiosAdapter>().mockImplementation(async req => ({
    config: req, headers: {}, data: req.data?.includes('"typing"') ? '' : { id: 'message-1' }, status: 200, statusText: 'OK',
  }))
  const original = axios.defaults.adapter
  axios.defaults.adapter = http
  try {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ token_type: 'Bearer', access_token: 'bot-token', expires_in: 3600 })))
    const api = new TeamsApi(config)
    const msg = { type: 'message', text: 'hello' }
    await expect(api.sendActivity(serviceUrl, 'c', msg)).resolves.toBe('message-1')
    await expect(api.sendActivity(serviceUrl, 'c', { type: 'typing' })).resolves.toBe('')
    await api.sendActivity(serviceUrl, 'c', msg, 'original')
    await api.sendThreadActivity(serviceUrl, 'c', 'original', 'wire-id', 'channel', msg)
    await api.updateActivity(serviceUrl, 'c', 'm', msg)
    await api.deleteActivity(serviceUrl, 'c', 'm')
    await api.setReaction(serviceUrl, 'c', 'm', 'like', true)
    await api.setReaction(serviceUrl, 'c', 'm', 'like', false)
    const requests = http.mock.calls.map(([request]) => request)
    expect(requests.map(r => r.method)).toEqual(['post', 'post', 'post', 'post', 'put', 'delete', 'put', 'delete'])
    expect(JSON.parse(requests[2].data)).toMatchObject({ replyToId: 'original', from: { id: activity.recipient.id }, conversation: { id: 'c', tenantId: config.tenantId } })
    expect(requests[3].url).toMatch(/\/replyChains\/original$/)
    expect(requests.at(-1)?.url).toContain('/v3/conversations/c/activities/m/reactions/like')
    for (const r of requests) {
      expect(r.headers.get('authorization')).toBe('Bearer bot-token')
      expect(r.maxRedirects).toBe(0)
    }
    await expect(api.sendActivity('https://unrelated.example', 'c', msg)).rejects.toThrow('Unrecognized')
    expect(http).toHaveBeenCalledTimes(8)
    http.mockRejectedValueOnce({ response: { status: 404 } })
    await expect(api.sendThreadActivity(serviceUrl, 'c', 'original', 'wire-id', 'channel', msg)).resolves.toBe('message-1')
    expect(http.mock.calls.at(-1)?.[0].url).toContain('/v3/conversations/wire-id/activities')
    http.mockRejectedValueOnce({ response: { status: 404 } })
    await expect(api.sendThreadActivity(serviceUrl, 'c', 'original', 'wire-id', 'personal', msg)).rejects.toThrow('404')
  } finally {
    axios.defaults.adapter = original
  }
})

it('uses the host-owned endpoint, preserves identity and credentials on rotation, and offers socket setup on private hosts', async () => {
  vi.stubEnv('HOST_PUBLIC_URL', 'https://gamut.example')
  vi.stubEnv('TEAMS_RELAY_GATEWAY_URL', '')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ token_type: 'Bearer', access_token: 'bot-token', expires_in: 3600 })))
  const setup = chatProviderSetup('teams', teamsConfigSchema)
  const input = { ...config, messagingEndpoint: 'https://elsewhere.example', relay: { endpointId: 'foreign' } }
  const { config: saved } = await setup.prepare(input, context)
  expect(saved.messagingEndpoint).toBe(`https://gamut.example/api/teams/messages/${config.appId}`)
  expect(saved.relay).toBeUndefined()
  expect(mergeChatIntegrationConfig('teams', JSON.stringify(saved), { clientSecret: '••••' })).toEqual(saved)
  expect(mergeChatIntegrationConfig('teams', JSON.stringify(saved), { clientSecret: 'rotated' })).toEqual({ ...saved, clientSecret: 'rotated' })
  expect(() => mergeChatIntegrationConfig('teams', JSON.stringify(saved), { tenantId: config.appId })).toThrow()
  vi.stubEnv('HOST_PUBLIC_URL', '')
  await expect(setup.prepare(input, context)).rejects.toThrow('public HTTPS')
  await expect(setup.prepare({ ...input, deliveryMode: 'socket' }, context)).resolves.toEqual({ config: { ...config, deliveryMode: 'socket' } })
})

it('provisions a verified private relay and releases its endpoint if key discovery fails', async () => {
  vi.stubEnv('HOST_PUBLIC_URL', '')
  vi.stubEnv('TEAMS_RELAY_GATEWAY_URL', 'https://gateway.example/api/teams-relay')
  const relay = { scope: 'local', endpointId: 'whep_test', url: 'https://platform.example/v1/hooks/whep_test' }
  const current = getWebhookRelay().snapshot()
  vi.spyOn(getWebhookRelay(), 'snapshot').mockReturnValue({ ...current, available: true, unavailableReason: null })
  const create = vi.spyOn(relayTransport, 'provisionIntegrationRelay').mockResolvedValue(relay)
  const release = vi.spyOn(relayTransport, 'disableIntegrationRelay').mockResolvedValue(undefined)
  const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' })
  let discover = true
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/key')) return Response.json(discover ? publicKey : {}, { status: discover ? 200 : 404 })
    return Response.json({ token_type: 'Bearer', access_token: 'bot-token', expires_in: 3600 })
  }))
  const saved = await prepareIntegrationSetup('teams', config, context)
  expect(create).toHaveBeenCalledWith(expect.any(String), undefined, expect.objectContaining({
    algorithm: 'hmac-sha256', encoding: 'hex', template: '{body}', header: 'X-Gamut-Teams-Signature',
  }))
  expect(saved.config.messagingEndpoint).toMatch(/^https:\/\/gateway.example\/api\/teams-relay\/messages\//)
  expect(saved.config.relay).toEqual(relay)
  const verification = create.mock.calls[0][2]!
  expect(JSON.stringify(saved.config)).not.toContain(verification.secret)
  expect(release).not.toHaveBeenCalled()
  discover = false
  await expect(prepareIntegrationSetup('teams', config, context)).rejects.toThrow('gateway key')
  expect(release).toHaveBeenCalledExactlyOnceWith(relay)
})
