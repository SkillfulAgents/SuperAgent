import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'

let testDir: string
let testDb: AppDatabase
let handle: TestDatabase

vi.mock('../db', () => ({
  get db() { return testDb },
}))

const captureExceptionMock = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}))

import {
  createChatIntegration,
  getChatIntegration,
  updateChatIntegration,
  listStartupChatIntegrations,
  DuplicateBotTokenError,
} from './chat-integration-service'
import { chatIntegrations } from '../db/schema'

describe('chat-integration-service', () => {
  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-integration-test-'))
    handle = await createTestDatabase()
    testDb = handle.db
    captureExceptionMock.mockReset()
  })

  afterEach(async () => {
    await handle.close()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  describe('createChatIntegration', () => {
    it('throws DuplicateBotTokenError when same provider + token is registered twice', async () => {
      const firstId = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'duplicate-token' },
      }))

      await expect(createChatIntegration({
        agentSlug: 'agent-b',
        provider: 'telegram',
        config: { botToken: 'duplicate-token' },
      })).rejects.toThrow(DuplicateBotTokenError)

      try {
        await createChatIntegration({
          agentSlug: 'agent-b',
          provider: 'telegram',
          config: { botToken: 'duplicate-token' },
        })
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateBotTokenError)
        expect((err as DuplicateBotTokenError).existingIntegrationId).toBe(firstId)
      }

      // Second insert must not have happened
      const rows = await testDb.select().from(chatIntegrations).all()
      expect(rows).toHaveLength(1)
    })

    it('allows different tokens for the same agent', async () => {
      await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-1' },
      })
      await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-2' },
      })

      const rows = await testDb.select().from(chatIntegrations).all()
      expect(rows).toHaveLength(2)
    })

    it('allows the same token string across different providers', async () => {
      // Unlikely in practice (slack and telegram tokens look nothing alike),
      // but the check is provider-scoped so this must succeed.
      await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'shared-token' },
      })
      await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'slack',
        config: { botToken: 'shared-token', appToken: 'xapp-x' },
      })

      const rows = await testDb.select().from(chatIntegrations).all()
      expect(rows).toHaveLength(2)
    })

    it('throws DuplicateBotTokenError when same phone number is registered twice for iMessage', async () => {
      const firstId = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15551234567', token: 'tok123' },
      }))

      await expect(createChatIntegration({
        agentSlug: 'agent-b',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw2.example.com', phoneNumber: '+15551234567', token: 'tok456' },
      })).rejects.toThrow(DuplicateBotTokenError)

      try {
        await createChatIntegration({
          agentSlug: 'agent-b',
          provider: 'imessage',
          config: { gatewayUrl: 'https://gw2.example.com', phoneNumber: '+15551234567', token: 'tok456' },
        })
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateBotTokenError)
        expect((err as DuplicateBotTokenError).existingIntegrationId).toBe(firstId)
      }

      // Second insert must not have happened
      const rows = await testDb.select().from(chatIntegrations).all()
      expect(rows).toHaveLength(1)
    })

    it('allows the same phone number across different providers', async () => {
      await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15551234567', token: 'tok123' },
      })
      await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: '+15551234567' },
      })

      const rows = await testDb.select().from(chatIntegrations).all()
      expect(rows).toHaveLength(2)
    })

    it('allows different phone numbers for iMessage', async () => {
      await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15551234567', token: 'tok123' },
      })
      await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15559876543', token: 'tok456' },
      })

      const rows = await testDb.select().from(chatIntegrations).all()
      expect(rows).toHaveLength(2)
    })
  })

  describe('updateChatIntegration', () => {
    it('preserves stored Slack credentials when PATCHing only behavior settings', async () => {
      const id = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'slack',
        config: {
          botToken: 'xoxb-secret',
          appToken: 'xapp-secret',
          channelId: 'C123',
          onlyMentioned: false,
        },
      }))

      expect((await updateChatIntegration(id, {
        config: { onlyMentioned: true },
      }))).toBe(true)

      expect(JSON.parse((await getChatIntegration(id))!.config)).toEqual({
        botToken: 'xoxb-secret',
        appToken: 'xapp-secret',
        channelId: 'C123',
        onlyMentioned: true,
      })
    })

    it('preserves stored credentials when a client echoes masked placeholders', async () => {
      const id = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'slack',
        config: { botToken: 'xoxb-secret', appToken: 'xapp-secret' },
      }))

      await updateChatIntegration(id, {
        config: {
          botToken: '********',
          appToken: '••••xapp',
          answerInThread: true,
        },
      })

      expect(JSON.parse((await getChatIntegration(id))!.config)).toEqual({
        botToken: 'xoxb-secret',
        appToken: 'xapp-secret',
        answerInThread: true,
      })
    })

    it('repairs an invalid stored config when PATCH supplies a complete replacement', async () => {
      const id = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'slack',
        config: { legacyBotToken: 'obsolete-shape' },
      }))

      expect((await updateChatIntegration(id, {
        config: {
          botToken: 'xoxb-repaired',
          appToken: 'xapp-repaired',
          onlyMentioned: true,
        },
      }))).toBe(true)

      expect(JSON.parse((await getChatIntegration(id))!.config)).toEqual({
        botToken: 'xoxb-repaired',
        appToken: 'xapp-repaired',
        onlyMentioned: true,
      })
    })

    it('rejects a partial PATCH when an invalid stored config cannot supply credentials', async () => {
      const id = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'slack',
        config: { legacyBotToken: 'obsolete-shape' },
      }))

      await expect(updateChatIntegration(id, {
        config: { onlyMentioned: true },
      })).rejects.toThrow()
    })

    it('allows settings-only edits on legacy rows whose token is already duplicated', async () => {
      await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'legacy-duplicate' },
      })
      const secondId = (await createChatIntegration({
        agentSlug: 'agent-b',
        provider: 'telegram',
        config: { botToken: 'originally-unique' },
      }))
      await testDb.update(chatIntegrations).set({ config: JSON.stringify({ botToken: 'legacy-duplicate' }) })
        .where(eq(chatIntegrations.id, secondId)).run()

      expect((await updateChatIntegration(secondId, {
        config: { draftStreaming: true },
      }))).toBe(true)
      expect(JSON.parse((await getChatIntegration(secondId))!.config)).toEqual({
        botToken: 'legacy-duplicate',
        draftStreaming: true,
      })
    })

    it('throws DuplicateBotTokenError when PATCHing config to an already-used token', async () => {
      const firstId = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-1' },
      }))
      const secondId = (await createChatIntegration({
        agentSlug: 'agent-b',
        provider: 'telegram',
        config: { botToken: 'token-2' },
      }))

      await expect(updateChatIntegration(secondId, {
        config: { botToken: 'token-1' },
      })).rejects.toThrow(DuplicateBotTokenError)

      try {
        await updateChatIntegration(secondId, { config: { botToken: 'token-1' } })
      } catch (err) {
        expect((err as DuplicateBotTokenError).existingIntegrationId).toBe(firstId)
      }
    })

    it('throws DuplicateBotTokenError when PATCHing iMessage config to an already-used phone number', async () => {
      const firstId = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15551234567', token: 'tok123' },
      }))
      const secondId = (await createChatIntegration({
        agentSlug: 'agent-b',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15559876543', token: 'tok456' },
      }))

      await expect(updateChatIntegration(secondId, {
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15551234567', token: 'tok456' },
      })).rejects.toThrow(DuplicateBotTokenError)

      try {
        await updateChatIntegration(secondId, {
          config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15551234567', token: 'tok456' },
        })
      } catch (err) {
        expect((err as DuplicateBotTokenError).existingIntegrationId).toBe(firstId)
      }
    })

    it('allows updating an integration to keep the same token (self-exclusion)', async () => {
      const id = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-1' },
      }))

      // Same token, plus extra config — should not trip the guard
      const ok = (await updateChatIntegration(id, { config: { botToken: 'token-1', chatId: '42' } }))
      expect(ok).toBe(true)
    })
  })

  describe('listStartupChatIntegrations', () => {
    async function insertRow(opts: {
      id: string
      token: string
      status: 'active' | 'paused' | 'error' | 'disconnected'
      updatedAt: Date
      provider?: 'telegram' | 'slack' | 'imessage'
    }) {
      const provider = opts.provider ?? 'telegram'
      const config = provider === 'imessage'
        ? { gatewayUrl: 'https://gw.example.com', phoneNumber: opts.token, token: 'tok123' }
        : { botToken: opts.token }
      await testDb.insert(chatIntegrations).values({
        id: opts.id,
        agentSlug: 'agent-a',
        provider,
        name: null,
        config: JSON.stringify(config),
        showToolCalls: false,
        status: opts.status,
        errorMessage: null,
        createdByUserId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: opts.updatedAt,
      }).run()
    }

    it('deduplicates rows sharing a bot token and prefers `active` over `error`', async () => {
      await insertRow({ id: 'err', token: 'shared', status: 'error', updatedAt: new Date('2026-04-10T00:00:00Z') })
      await insertRow({ id: 'ok',  token: 'shared', status: 'active', updatedAt: new Date('2026-04-01T00:00:00Z') })

      const results = (await listStartupChatIntegrations())
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('ok')
    })

    it('among rows with the same status, picks the most-recently updated', async () => {
      await insertRow({ id: 'old', token: 'shared', status: 'active', updatedAt: new Date('2026-04-01T00:00:00Z') })
      await insertRow({ id: 'new', token: 'shared', status: 'active', updatedAt: new Date('2026-04-15T00:00:00Z') })

      const results = (await listStartupChatIntegrations())
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('new')
    })

    it('reports a Sentry warning when duplicates are detected', async () => {
      await insertRow({ id: 'a', token: 'shared', status: 'active', updatedAt: new Date('2026-04-01T00:00:00Z') })
      await insertRow({ id: 'b', token: 'shared', status: 'error',  updatedAt: new Date('2026-04-02T00:00:00Z') })

      await listStartupChatIntegrations()

      expect(captureExceptionMock).toHaveBeenCalledTimes(1)
      const [err, opts] = captureExceptionMock.mock.calls[0] as [Error, { level?: string; tags?: Record<string, string> }]
      expect(err).toBeInstanceOf(Error)
      expect(opts.level).toBe('warning')
      expect(opts.tags).toMatchObject({ component: 'chat-integration', operation: 'list-startup' })
    })

    it('does not report Sentry when there are no duplicates', async () => {
      await insertRow({ id: 'a', token: 'token-1', status: 'active', updatedAt: new Date('2026-04-01T00:00:00Z') })
      await insertRow({ id: 'b', token: 'token-2', status: 'active', updatedAt: new Date('2026-04-02T00:00:00Z') })

      const results = (await listStartupChatIntegrations())
      expect(results).toHaveLength(2)
      expect(captureExceptionMock).not.toHaveBeenCalled()
    })

    it('keeps rows that have no parseable token (defensive)', async () => {
      // Row with malformed JSON config — safeParseConfig returns null, so it can't be deduped.
      // We still want it in the startup list; the connector will flip it to `error` itself.
      await testDb.insert(chatIntegrations).values({
        id: 'bad',
        agentSlug: 'agent-a',
        provider: 'telegram',
        name: null,
        config: 'not-json',
        showToolCalls: false,
        status: 'active',
        errorMessage: null,
        createdByUserId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }).run()

      const results = (await listStartupChatIntegrations())
      expect(results.find(r => r.id === 'bad')).toBeDefined()
      // Malformed JSON is a real bug — should have been captured
      expect(captureExceptionMock).toHaveBeenCalled()
      const parseCall = captureExceptionMock.mock.calls.find(([, opts]) =>
        (opts as { tags?: { operation?: string } }).tags?.operation === 'parse-config',
      )
      expect(parseCall).toBeDefined()
    })

    it('deduplicates iMessage rows sharing a phone number', async () => {
      await insertRow({ id: 'im-err', token: '+15551234567', status: 'error',  updatedAt: new Date('2026-04-10T00:00:00Z'), provider: 'imessage' })
      await insertRow({ id: 'im-ok',  token: '+15551234567', status: 'active', updatedAt: new Date('2026-04-01T00:00:00Z'), provider: 'imessage' })

      const results = (await listStartupChatIntegrations())
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('im-ok')
    })
  })

  describe('sessionTimeout', () => {
    it('stores sessionTimeout on create', async () => {
      const id = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-timeout' },
        sessionTimeout: 4,
      }))
      const row = (await getChatIntegration(id))
      expect(row?.sessionTimeout).toBe(4)
    })

    it('defaults sessionTimeout to null when not provided', async () => {
      const id = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-no-timeout' },
      }))
      const row = (await getChatIntegration(id))
      expect(row?.sessionTimeout).toBeNull()
    })

    it('updates sessionTimeout via updateChatIntegration', async () => {
      const id = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-update-timeout' },
      }))
      await updateChatIntegration(id, { sessionTimeout: 12 })
      expect((await getChatIntegration(id))?.sessionTimeout).toBe(12)
    })

    it('clears sessionTimeout by setting to null', async () => {
      const id = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-clear-timeout' },
        sessionTimeout: 6,
      }))
      expect((await getChatIntegration(id))?.sessionTimeout).toBe(6)

      await updateChatIntegration(id, { sessionTimeout: null })
      expect((await getChatIntegration(id))?.sessionTimeout).toBeNull()
    })
  })

  describe('requireApproval (secure-by-default invariant)', () => {
    // The allowlist only protects if new integrations default to gated. Assert
    // the persisted row, not the call args: an omitted flag must land as `true`.
    it('persists requireApproval=true when the flag is omitted', async () => {
      const id = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'tok-omitted' },
      }))
      expect((await getChatIntegration(id))?.requireApproval).toBe(true)
    })

    it('ignores any caller-supplied requireApproval at create and stays private', async () => {
      // The field is intentionally not in CreateChatIntegrationParams; a caller
      // smuggling it in (e.g. via an untyped request body) must NOT create a
      // public bot — making a bot public is owner-only via PATCH.
      const id = (await createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'tok-override-ignored' },
        requireApproval: false,
      } as Parameters<typeof createChatIntegration>[0] & { requireApproval: boolean }))
      expect((await getChatIntegration(id))?.requireApproval).toBe(true)
    })
  })
})

describe('DuplicateBotTokenError', () => {
  it('carries the existing integration id and keeps its name', async () => {
    const err = new DuplicateBotTokenError('abc-123')
    expect(err.name).toBe('DuplicateBotTokenError')
    expect(err.existingIntegrationId).toBe('abc-123')
    expect(err.message).toContain('abc-123')
    expect(err instanceof Error).toBe(true)
  })
})
