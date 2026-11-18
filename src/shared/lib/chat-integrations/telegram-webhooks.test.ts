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
  create: vi.fn(async (_scope: string, _spec: { name: string; verification?: unknown }) => {
    const n = relayEndpoints.create.mock.calls.length
    return { id: `whep_${n}`, url: `https://relay.test/v1/hooks/whep_${n}`, name: 'Telegram', status: 'active' }
  }),
  disable: vi.fn(async (_scope: string, _id: string) => {}),
}))
vi.mock('../webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../webhook-relay')>()),
  getWebhookRelay: () => ({ createEndpoint: relayEndpoints.create, disableEndpoint: relayEndpoints.disable }),
}))
const botApi = vi.hoisted(() => ({
  tokens: [] as string[],
  webhookUrl: '',
  getWebhookInfo: vi.fn(async () => ({ url: botApi.webhookUrl, has_custom_certificate: false, pending_update_count: 0 })),
  deleteWebhook: vi.fn(async (_options?: unknown) => true),
}))
vi.mock('grammy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('grammy')>()),
  Api: class {
    constructor(token: string) { botApi.tokens.push(token) }
    getWebhookInfo = botApi.getWebhookInfo
    deleteWebhook = botApi.deleteWebhook
  },
}))

import { createAgentIntegration, deleteAgentIntegration, getAgentIntegration, updateAgentIntegration } from '../services/agent-integration-service'
import { mergeChatIntegrationConfig, telegramConfigSchema } from './config-schema'
import { relayedTelegramUpdate } from './test-helpers'
import { checkTelegramWebhook, deleteTelegramWebhook, ensureTelegramWebhook, telegramSecretToken } from './telegram-webhooks'

const SECRET = 'a'.repeat(64)
const update = { update_id: 7, message: { message_id: 3, date: 0, chat: { id: 42, type: 'private' }, text: 'hi' } }

beforeEach(async () => {
  vi.clearAllMocks()
  botApi.tokens.length = 0
  botApi.webhookUrl = ''
  handle = await createTestDatabase(); testDb = handle.db
})
afterEach(async () => { await handle.close() })

describe('checkTelegramWebhook', () => {
  it('accepts a post carrying the secret token, in any header case and either body encoding', () => {
    expect(checkTelegramWebhook(relayedTelegramUpdate(update, SECRET), SECRET)).toEqual({ ok: true, update })
    expect(checkTelegramWebhook(relayedTelegramUpdate(update, SECRET, { base64: true }), SECRET)).toEqual({ ok: true, update })

    const event = relayedTelegramUpdate(update, null)
    ;(event.payload as { headers: Record<string, string> }).headers['X-Telegram-Bot-Api-Secret-Token'] = SECRET
    expect(checkTelegramWebhook(event, SECRET).ok).toBe(true)
  })

  it('rejects another token, a missing one, or one differing only in case', () => {
    expect(checkTelegramWebhook(relayedTelegramUpdate(update, 'b'.repeat(64)), SECRET)).toEqual({ ok: false, reason: 'secret' })
    expect(checkTelegramWebhook(relayedTelegramUpdate(update, null), SECRET)).toEqual({ ok: false, reason: 'secret' })
    expect(checkTelegramWebhook(relayedTelegramUpdate(update, SECRET.slice(1)), SECRET)).toEqual({ ok: false, reason: 'secret' })
    expect(checkTelegramWebhook(relayedTelegramUpdate(update, 'A'.repeat(64)), SECRET)).toEqual({ ok: false, reason: 'secret' })
  })

  it('rejects handshakes and bodies that are not updates', () => {
    const handshake = relayedTelegramUpdate(update, SECRET)
    ;(handshake.payload as { kind: string }).kind = 'handshake'
    expect(checkTelegramWebhook(handshake, SECRET)).toEqual({ ok: false, reason: 'handshake' })

    expect(checkTelegramWebhook(relayedTelegramUpdate({ message: update.message }, SECRET), SECRET)).toEqual({ ok: false, reason: 'malformed' })
    const notJson = relayedTelegramUpdate(update, SECRET)
    ;(notJson.payload as { body: string }).body = 'not json'
    expect(checkTelegramWebhook(notJson, SECRET)).toEqual({ ok: false, reason: 'malformed' })
    expect(checkTelegramWebhook({ ...notJson, payload: null }, SECRET)).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('telegramSecretToken', () => {
  it('binds the secret to the bot: a revoked token keeps it, another bot gets its own', () => {
    const token = telegramSecretToken(SECRET, '123:abc')
    // Telegram allows 1-256 of A-Z, a-z, 0-9, _ and -.
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(telegramSecretToken(SECRET, '123:revoked-and-reissued')).toBe(token)
    expect(telegramSecretToken(SECRET, '456:abc')).not.toBe(token)
    expect(telegramSecretToken('b'.repeat(64), '123:abc')).not.toBe(token)
  })
})

describe('ensureTelegramWebhook', () => {
  const install = (config: Record<string, unknown> = {}) =>
    createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: '123:abc', ...config }, createdByUserId: 'owner' })
  const record = (id: string) => ({ id, agentSlug: 'agent', createdByUserId: 'owner' })
  const storedConfig = async (id: string) => telegramConfigSchema.parse(JSON.parse((await getAgentIntegration(id))!.config))

  it('mints an endpoint and a secret token once, then keeps the address', async () => {
    const id = await install({ richMessages: false })

    const first = await ensureTelegramWebhook(record(id))
    expect(first).toEqual({ relay: { endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_owner' }, secret: expect.stringMatching(/^[0-9a-f]{64}$/) })
    // Telegram doesn't sign its posts, so the relay has no profile to check them with.
    expect(relayEndpoints.create).toHaveBeenCalledWith('sub_owner', { name: 'Telegram integration for agent' })
    expect(await storedConfig(id)).toEqual({ botToken: '123:abc', richMessages: false, relay: first!.relay, webhookSecret: first!.secret })

    expect(await ensureTelegramWebhook(record(id))).toEqual(first)
    expect(relayEndpoints.create).toHaveBeenCalledTimes(1)
  })

  it('stores one endpoint when two connects race, and disables the other', async () => {
    const id = await install()

    const [a, b] = await Promise.all([ensureTelegramWebhook(record(id)), ensureTelegramWebhook(record(id))])

    expect(a).toEqual(b)
    expect(relayEndpoints.create).toHaveBeenCalledTimes(2)
    const unused = a!.relay.endpointId === 'whep_1' ? 'whep_2' : 'whep_1'
    expect(relayEndpoints.disable).toHaveBeenCalledWith('sub_owner', unused)
  })

  it('keeps a settings edit made while it mints', async () => {
    const id = await install()
    relayEndpoints.create.mockImplementationOnce(async () => {
      await updateAgentIntegration(id, { config: { botToken: '123:abc', draftStreaming: false } })
      return { id: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', name: 'Telegram', status: 'active' }
    })

    const webhook = await ensureTelegramWebhook(record(id))

    expect(await storedConfig(id)).toEqual({ botToken: '123:abc', draftStreaming: false, relay: webhook!.relay, webhookSecret: webhook!.secret })
  })

  it('returns null and disables the endpoint when the installation is gone', async () => {
    expect(await ensureTelegramWebhook(record('missing'))).toBeNull()
    expect(relayEndpoints.create).not.toHaveBeenCalled()

    const id = await install()
    relayEndpoints.create.mockImplementationOnce(async () => {
      await deleteAgentIntegration(id)
      return { id: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', name: 'Telegram', status: 'active' }
    })
    expect(await ensureTelegramWebhook(record(id))).toBeNull()
    expect(relayEndpoints.disable).toHaveBeenCalledWith('sub_owner', 'whep_1')
  })

  it('is host-owned: a settings patch keeps the stored endpoint and secret token', async () => {
    const id = await install()
    const webhook = await ensureTelegramWebhook(record(id))
    const stored = (await getAgentIntegration(id))!.config

    const merged = mergeChatIntegrationConfig('telegram', stored, { relay: { endpointId: 'whep_x', url: 'https://evil.test/', scope: 'x' }, webhookSecret: 'b'.repeat(64), richMessages: true })

    expect(merged).toMatchObject({ relay: webhook!.relay, webhookSecret: webhook!.secret, richMessages: true })
  })
})

describe('deleteTelegramWebhook', () => {
  const relay = { endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_owner' }

  it('deletes the bot webhook while it is this endpoint, keeping held updates', async () => {
    botApi.webhookUrl = relay.url
    await deleteTelegramWebhook({ botToken: '123:abc', relay })
    expect(botApi.tokens).toEqual(['123:abc'])
    expect(botApi.deleteWebhook).toHaveBeenCalledWith({ drop_pending_updates: false }, expect.anything())
  })

  it('leaves a webhook that points elsewhere, and does nothing without an endpoint', async () => {
    botApi.webhookUrl = 'https://elsewhere.test/hook'
    await deleteTelegramWebhook({ botToken: '123:abc', relay })
    await deleteTelegramWebhook({ botToken: '123:abc' })
    expect(botApi.deleteWebhook).not.toHaveBeenCalled()
    expect(botApi.tokens).toEqual(['123:abc'])
  })
})
