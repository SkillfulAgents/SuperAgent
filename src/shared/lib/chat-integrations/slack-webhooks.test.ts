import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../db', () => ({ get db() { return testDb } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('../services/platform-auth-service', () => ({ getStoredPlatformMemberId: () => 'sub_owner' }))
vi.mock('../services/webhook-trigger-service', () => ({ resolvePlatformMemberForCandidates: async () => null }))
const relayEndpoints = vi.hoisted(() => ({
  unavailable: false,
  create: vi.fn(async (_scope: string, _spec: { name: string; verification?: unknown }) => {
    const n = relayEndpoints.create.mock.calls.length
    return { id: `whep_${n}`, url: `https://relay.test/v1/hooks/whep_${n}`, name: 'Slack', status: 'active' }
  }),
  update: vi.fn(async (_scope: string, id: string, _changes: { verification?: unknown }) => ({ id, url: `https://relay.test/v1/hooks/${id}`, name: 'Slack', status: 'active' })),
  disable: vi.fn(async (_scope: string, _id: string) => {}),
}))
vi.mock('../webhook-relay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-relay')>()
  const unavailable = () => { if (relayEndpoints.unavailable) throw new actual.WebhookRelayUnavailableError('platform_disconnected') }
  return {
    ...actual,
    getWebhookRelay: () => ({
      createEndpoint: async (...args: Parameters<typeof relayEndpoints.create>) => { unavailable(); return relayEndpoints.create(...args) },
      updateEndpoint: async (...args: Parameters<typeof relayEndpoints.update>) => { unavailable(); return relayEndpoints.update(...args) },
      disableEndpoint: relayEndpoints.disable,
    }),
  }
})

import { createAgentIntegration, getAgentIntegration } from '../services/agent-integration-service'
import { verificationProfileSchema } from '../services/webhook-endpoint-schema'
import { IntegrationSetupError } from '../agent-integrations/setup-types'
import { slackConfigSchema } from './config-schema'
import { relayedSlackPost } from './test-helpers'
import { checkSlackWebhook, recordSlackWebhookStatus, slackRequestKey, slackVerificationProfile, updateSlackWebhookSettings } from './slack-webhooks'

const SECRET = '8f742231b10e8888abcd99yyyzzz85a5'
const message = { type: 'event_callback', event_id: 'Ev1', event: { type: 'message', channel: 'D1', user: 'U1', text: 'hi', ts: '1760000000.000100' } }
const click = { type: 'block_actions', trigger_id: 'tr_1', actions: [{ action_id: 'answer_0', value: '{}' }] }
const relay = { endpointId: 'whep_9', url: 'https://relay.test/v1/hooks/whep_9', scope: 'sub_owner' }

beforeEach(async () => {
  vi.clearAllMocks()
  relayEndpoints.unavailable = false
  handle = await createTestDatabase(); testDb = handle.db
})
afterEach(async () => { await handle.close() })

async function installation(config: Record<string, unknown>) {
  const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'slack', config: slackConfigSchema.parse(config), createdByUserId: 'owner' })
  return (await getAgentIntegration(id))!
}
async function storedConfig(id: string) {
  return slackConfigSchema.parse(JSON.parse((await getAgentIntegration(id))!.config))
}

describe('slackVerificationProfile', () => {
  it('is a profile the endpoint accepts, matching Slack v0 signatures', () => {
    expect(verificationProfileSchema.parse(slackVerificationProfile(SECRET))).toMatchObject({
      algorithm: 'hmac-sha256', header: 'x-slack-signature', prefix: 'v0=', template: 'v0:{timestamp}:{body}', timestamp_header: 'x-slack-request-timestamp', secret: SECRET,
    })
  })
})

describe('checkSlackWebhook', () => {
  it('reads a signed event, in either body encoding', () => {
    expect(checkSlackWebhook(relayedSlackPost(message, SECRET), SECRET)).toEqual({ ok: true, kind: 'request', body: message })
    expect(checkSlackWebhook(relayedSlackPost(message, SECRET, { base64: true }), SECRET)).toEqual({ ok: true, kind: 'request', body: message })
  })

  it('reads a signed interaction from its form-encoded payload', () => {
    expect(checkSlackWebhook(relayedSlackPost(click, SECRET, { form: true }), SECRET)).toEqual({ ok: true, kind: 'request', body: click })
  })

  it('checks freshness as of when the endpoint received the post, not when it is claimed', () => {
    const hourAgo = Math.floor(Date.now() / 1000) - 3600
    const claimedLate = relayedSlackPost(message, SECRET, { timestamp: hourAgo, receivedAt: new Date(hourAgo * 1000 + 2000).toISOString() })
    expect(checkSlackWebhook(claimedLate, SECRET).ok).toBe(true)
    // Already stale when it arrived: a replay.
    const replayed = relayedSlackPost(message, SECRET, { timestamp: hourAgo })
    expect(checkSlackWebhook(replayed, SECRET)).toEqual({ ok: false, reason: 'signature', edgeVerified: false })
  })

  it('rejects another secret, a missing signature, or a changed body, saying whether the endpoint had accepted it', () => {
    expect(checkSlackWebhook(relayedSlackPost(message, 'other-secret'), SECRET)).toEqual({ ok: false, reason: 'signature', edgeVerified: false })
    expect(checkSlackWebhook(relayedSlackPost(message, null), SECRET)).toEqual({ ok: false, reason: 'signature', edgeVerified: false })
    const tampered = relayedSlackPost(message, SECRET, { edgeVerified: true })
    ;(tampered.payload as { body: string }).body = JSON.stringify({ ...message, event: { ...message.event, text: 'transfer' } })
    expect(checkSlackWebhook(tampered, SECRET)).toEqual({ ok: false, reason: 'signature', edgeVerified: true })
  })

  it('verifies Slack’s URL check like any post, then reports it as the handshake', () => {
    const challenge = { type: 'url_verification', token: 't', challenge: 'abc' }
    expect(checkSlackWebhook(relayedSlackPost(challenge, SECRET, { handshake: true }), SECRET)).toEqual({ ok: true, kind: 'handshake' })
    expect(checkSlackWebhook(relayedSlackPost(challenge, 'other-secret', { handshake: true }), SECRET)).toMatchObject({ ok: false, reason: 'signature' })
  })

  it('rejects bodies that are not Slack requests, even signed', () => {
    const notJson = relayedSlackPost(message, SECRET)
    const payload = notJson.payload as { body: string; headers: Record<string, string> }
    payload.body = 'not json'
    payload.headers['x-slack-signature'] = `v0=${createHmac('sha256', SECRET).update(`v0:${payload.headers['x-slack-request-timestamp']}:not json`).digest('hex')}`
    expect(checkSlackWebhook(notJson, SECRET)).toEqual({ ok: false, reason: 'malformed' })
    expect(checkSlackWebhook(relayedSlackPost({ event: {} }, SECRET), SECRET)).toEqual({ ok: false, reason: 'malformed' })
    expect(checkSlackWebhook({ ...notJson, payload: null }, SECRET)).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('slackRequestKey', () => {
  it('names an event by its event_id and an interaction by its trigger_id', () => {
    expect(slackRequestKey(message)).toBe('event_callback:Ev1')
    expect(slackRequestKey(click)).toBe('block_actions:tr_1')
    expect(slackRequestKey({ type: 'event_callback' })).toBeNull()
  })
})

describe('recordSlackWebhookStatus', () => {
  it('records what posts showed, only for the secret and endpoint they were checked against', async () => {
    const row = await installation({ botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: SECRET, relay })
    expect(await recordSlackWebhookStatus(row.id, 'verified', { signingSecret: 'old-secret', endpointId: relay.endpointId })).toBe(false)
    expect(await recordSlackWebhookStatus(row.id, 'verified', { signingSecret: SECRET, endpointId: 'whep_old' })).toBe(false)
    expect((await storedConfig(row.id)).webhookStatus).toBeUndefined()

    expect(await recordSlackWebhookStatus(row.id, 'verified', { signingSecret: SECRET, endpointId: relay.endpointId })).toBe(true)
    expect(await storedConfig(row.id)).toMatchObject({ webhookStatus: 'verified', botToken: 'xoxb-1', relay })
  })
})

describe('updateSlackWebhookSettings', () => {
  it('sets webhooks up with the signing secret in the same change, the endpoint checking Slack’s signatures', async () => {
    const row = await installation({ botToken: 'xoxb-1', appToken: 'xapp-1' })
    expect(await updateSlackWebhookSettings(row, { settings: { webhooks: true }, config: { signingSecret: SECRET } })).toEqual({ reconnect: true })

    expect(relayEndpoints.create).toHaveBeenCalledWith('sub_owner', expect.objectContaining({ name: 'Slack integration for agent', verification: slackVerificationProfile(SECRET) }))
    expect((await storedConfig(row.id)).relay).toEqual({ endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_owner' })
  })

  it('uses a saved signing secret, and needs one', async () => {
    const without = await installation({ botToken: 'xoxb-1', appToken: 'xapp-1' })
    await expect(updateSlackWebhookSettings(without, { settings: { webhooks: true } })).rejects.toBeInstanceOf(IntegrationSetupError)
    // A masked placeholder is not a secret.
    await expect(updateSlackWebhookSettings(without, { settings: { webhooks: true }, config: { signingSecret: '••••••••' } })).rejects.toBeInstanceOf(IntegrationSetupError)
    expect(relayEndpoints.create).not.toHaveBeenCalled()

    const saved = await installation({ botToken: 'xoxb-2', appToken: 'xapp-2', signingSecret: SECRET })
    await updateSlackWebhookSettings(saved, { settings: { webhooks: true } })
    expect(relayEndpoints.create).toHaveBeenCalledWith('sub_owner', expect.objectContaining({ verification: slackVerificationProfile(SECRET) }))
  })

  it('removes webhooks with an app-level token, storing a new one together with the removal', async () => {
    const row = await installation({ botToken: 'xoxb-1', signingSecret: SECRET, relay, webhookStatus: 'verified' })
    await expect(updateSlackWebhookSettings(row, { settings: { webhooks: false } })).rejects.toBeInstanceOf(IntegrationSetupError)
    expect(relayEndpoints.disable).not.toHaveBeenCalled()

    expect(await updateSlackWebhookSettings(row, { settings: { webhooks: false }, config: { appToken: 'xapp-new' } })).toEqual({ reconnect: true })
    const config = await storedConfig(row.id)
    expect(config).toMatchObject({ appToken: 'xapp-new', signingSecret: SECRET })
    expect(config.relay).toBeUndefined()
    expect(config.webhookStatus).toBeUndefined()
    expect(relayEndpoints.disable).toHaveBeenCalledWith('sub_owner', 'whep_9')
  })

  it('gives the endpoint a new signing secret', async () => {
    const row = await installation({ botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: SECRET, relay })
    expect(await updateSlackWebhookSettings(row, { config: { signingSecret: 'new-secret' } })).toEqual({ reconnect: true })
    expect(relayEndpoints.update).toHaveBeenCalledWith('sub_owner', 'whep_9', { verification: slackVerificationProfile('new-secret') })

    // The same secret again, or other settings, leave the endpoint alone.
    vi.clearAllMocks()
    expect(await updateSlackWebhookSettings(row, { config: { signingSecret: SECRET, onlyMentioned: true } })).toEqual({ reconnect: false })
    expect(relayEndpoints.update).not.toHaveBeenCalled()
  })

  it('refuses a new signing secret while the relay can’t take it', async () => {
    const row = await installation({ botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: SECRET, relay })
    relayEndpoints.unavailable = true
    await expect(updateSlackWebhookSettings(row, { config: { signingSecret: 'new-secret' } })).rejects.toThrow(/webhook relay is unavailable/)
  })
})
