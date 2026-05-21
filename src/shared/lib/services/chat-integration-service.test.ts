import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() { return testDb },
  get sqlite() { return testSqlite },
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
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    captureExceptionMock.mockReset()
  })

  afterEach(async () => {
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  describe('createChatIntegration', () => {
    it('throws DuplicateBotTokenError when same provider + token is registered twice', () => {
      const firstId = createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'duplicate-token' },
      })

      expect(() => createChatIntegration({
        agentSlug: 'agent-b',
        provider: 'telegram',
        config: { botToken: 'duplicate-token' },
      })).toThrow(DuplicateBotTokenError)

      try {
        createChatIntegration({
          agentSlug: 'agent-b',
          provider: 'telegram',
          config: { botToken: 'duplicate-token' },
        })
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateBotTokenError)
        expect((err as DuplicateBotTokenError).existingIntegrationId).toBe(firstId)
      }

      // Second insert must not have happened
      const rows = testDb.select().from(chatIntegrations).all()
      expect(rows).toHaveLength(1)
    })

    it('allows different tokens for the same agent', () => {
      createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-1' },
      })
      createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-2' },
      })

      const rows = testDb.select().from(chatIntegrations).all()
      expect(rows).toHaveLength(2)
    })

    it('allows the same token string across different providers', () => {
      // Unlikely in practice (slack and telegram tokens look nothing alike),
      // but the check is provider-scoped so this must succeed.
      createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'shared-token' },
      })
      createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'slack',
        config: { botToken: 'shared-token', appToken: 'xapp-x' },
      })

      const rows = testDb.select().from(chatIntegrations).all()
      expect(rows).toHaveLength(2)
    })

    it('throws DuplicateBotTokenError when same phone number is registered twice for iMessage', () => {
      const firstId = createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15551234567', token: 'tok123' },
      })

      expect(() => createChatIntegration({
        agentSlug: 'agent-b',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw2.example.com', phoneNumber: '+15551234567', token: 'tok456' },
      })).toThrow(DuplicateBotTokenError)

      try {
        createChatIntegration({
          agentSlug: 'agent-b',
          provider: 'imessage',
          config: { gatewayUrl: 'https://gw2.example.com', phoneNumber: '+15551234567', token: 'tok456' },
        })
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateBotTokenError)
        expect((err as DuplicateBotTokenError).existingIntegrationId).toBe(firstId)
      }

      // Second insert must not have happened
      const rows = testDb.select().from(chatIntegrations).all()
      expect(rows).toHaveLength(1)
    })

    it('allows the same phone number across different providers', () => {
      createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15551234567', token: 'tok123' },
      })
      createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: '+15551234567' },
      })

      const rows = testDb.select().from(chatIntegrations).all()
      expect(rows).toHaveLength(2)
    })

    it('allows different phone numbers for iMessage', () => {
      createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15551234567', token: 'tok123' },
      })
      createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15559876543', token: 'tok456' },
      })

      const rows = testDb.select().from(chatIntegrations).all()
      expect(rows).toHaveLength(2)
    })
  })

  describe('updateChatIntegration', () => {
    it('throws DuplicateBotTokenError when PATCHing config to an already-used token', () => {
      const firstId = createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-1' },
      })
      const secondId = createChatIntegration({
        agentSlug: 'agent-b',
        provider: 'telegram',
        config: { botToken: 'token-2' },
      })

      expect(() => updateChatIntegration(secondId, {
        config: { botToken: 'token-1' },
      })).toThrow(DuplicateBotTokenError)

      try {
        updateChatIntegration(secondId, { config: { botToken: 'token-1' } })
      } catch (err) {
        expect((err as DuplicateBotTokenError).existingIntegrationId).toBe(firstId)
      }
    })

    it('throws DuplicateBotTokenError when PATCHing iMessage config to an already-used phone number', () => {
      const firstId = createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15551234567', token: 'tok123' },
      })
      const secondId = createChatIntegration({
        agentSlug: 'agent-b',
        provider: 'imessage',
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15559876543', token: 'tok456' },
      })

      expect(() => updateChatIntegration(secondId, {
        config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15551234567', token: 'tok456' },
      })).toThrow(DuplicateBotTokenError)

      try {
        updateChatIntegration(secondId, {
          config: { gatewayUrl: 'https://gw.example.com', phoneNumber: '+15551234567', token: 'tok456' },
        })
      } catch (err) {
        expect((err as DuplicateBotTokenError).existingIntegrationId).toBe(firstId)
      }
    })

    it('allows updating an integration to keep the same token (self-exclusion)', () => {
      const id = createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-1' },
      })

      // Same token, plus extra config — should not trip the guard
      const ok = updateChatIntegration(id, { config: { botToken: 'token-1', chatId: '42' } })
      expect(ok).toBe(true)
    })
  })

  describe('listStartupChatIntegrations', () => {
    function insertRow(opts: {
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
      testDb.insert(chatIntegrations).values({
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

    it('deduplicates rows sharing a bot token and prefers `active` over `error`', () => {
      insertRow({ id: 'err', token: 'shared', status: 'error', updatedAt: new Date('2026-04-10T00:00:00Z') })
      insertRow({ id: 'ok',  token: 'shared', status: 'active', updatedAt: new Date('2026-04-01T00:00:00Z') })

      const results = listStartupChatIntegrations()
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('ok')
    })

    it('among rows with the same status, picks the most-recently updated', () => {
      insertRow({ id: 'old', token: 'shared', status: 'active', updatedAt: new Date('2026-04-01T00:00:00Z') })
      insertRow({ id: 'new', token: 'shared', status: 'active', updatedAt: new Date('2026-04-15T00:00:00Z') })

      const results = listStartupChatIntegrations()
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('new')
    })

    it('reports a Sentry warning when duplicates are detected', () => {
      insertRow({ id: 'a', token: 'shared', status: 'active', updatedAt: new Date('2026-04-01T00:00:00Z') })
      insertRow({ id: 'b', token: 'shared', status: 'error',  updatedAt: new Date('2026-04-02T00:00:00Z') })

      listStartupChatIntegrations()

      expect(captureExceptionMock).toHaveBeenCalledTimes(1)
      const [err, opts] = captureExceptionMock.mock.calls[0] as [Error, { level?: string; tags?: Record<string, string> }]
      expect(err).toBeInstanceOf(Error)
      expect(opts.level).toBe('warning')
      expect(opts.tags).toMatchObject({ component: 'chat-integration', operation: 'list-startup' })
    })

    it('does not report Sentry when there are no duplicates', () => {
      insertRow({ id: 'a', token: 'token-1', status: 'active', updatedAt: new Date('2026-04-01T00:00:00Z') })
      insertRow({ id: 'b', token: 'token-2', status: 'active', updatedAt: new Date('2026-04-02T00:00:00Z') })

      const results = listStartupChatIntegrations()
      expect(results).toHaveLength(2)
      expect(captureExceptionMock).not.toHaveBeenCalled()
    })

    it('keeps rows that have no parseable token (defensive)', () => {
      // Row with malformed JSON config — safeParseConfig returns null, so it can't be deduped.
      // We still want it in the startup list; the connector will flip it to `error` itself.
      testDb.insert(chatIntegrations).values({
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

      const results = listStartupChatIntegrations()
      expect(results.find(r => r.id === 'bad')).toBeDefined()
      // Malformed JSON is a real bug — should have been captured
      expect(captureExceptionMock).toHaveBeenCalled()
      const parseCall = captureExceptionMock.mock.calls.find(([, opts]) =>
        (opts as { tags?: { operation?: string } }).tags?.operation === 'parse-config',
      )
      expect(parseCall).toBeDefined()
    })

    it('deduplicates iMessage rows sharing a phone number', () => {
      insertRow({ id: 'im-err', token: '+15551234567', status: 'error',  updatedAt: new Date('2026-04-10T00:00:00Z'), provider: 'imessage' })
      insertRow({ id: 'im-ok',  token: '+15551234567', status: 'active', updatedAt: new Date('2026-04-01T00:00:00Z'), provider: 'imessage' })

      const results = listStartupChatIntegrations()
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('im-ok')
    })
  })

  describe('sessionTimeout', () => {
    it('stores sessionTimeout on create', () => {
      const id = createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-timeout' },
        sessionTimeout: 4,
      })
      const row = getChatIntegration(id)
      expect(row?.sessionTimeout).toBe(4)
    })

    it('defaults sessionTimeout to null when not provided', () => {
      const id = createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-no-timeout' },
      })
      const row = getChatIntegration(id)
      expect(row?.sessionTimeout).toBeNull()
    })

    it('updates sessionTimeout via updateChatIntegration', () => {
      const id = createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-update-timeout' },
      })
      updateChatIntegration(id, { sessionTimeout: 12 })
      expect(getChatIntegration(id)?.sessionTimeout).toBe(12)
    })

    it('clears sessionTimeout by setting to null', () => {
      const id = createChatIntegration({
        agentSlug: 'agent-a',
        provider: 'telegram',
        config: { botToken: 'token-clear-timeout' },
        sessionTimeout: 6,
      })
      expect(getChatIntegration(id)?.sessionTimeout).toBe(6)

      updateChatIntegration(id, { sessionTimeout: null })
      expect(getChatIntegration(id)?.sessionTimeout).toBeNull()
    })
  })
})

describe('DuplicateBotTokenError', () => {
  it('carries the existing integration id and keeps its name', () => {
    const err = new DuplicateBotTokenError('abc-123')
    expect(err.name).toBe('DuplicateBotTokenError')
    expect(err.existingIntegrationId).toBe('abc-123')
    expect(err.message).toContain('abc-123')
    expect(err instanceof Error).toBe(true)
  })
})
