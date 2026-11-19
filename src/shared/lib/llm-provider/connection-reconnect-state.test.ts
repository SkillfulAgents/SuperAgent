import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import { llmConnections } from '../db/schema'
import type { AppSettings } from '../config/settings'

const state = vi.hoisted(() => ({ db: null as TestDatabase['db'] | null }))
vi.mock('../db', () => ({ get db() { return state.db } }))
vi.mock('../config/settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/settings')>(),
  getSettings: async () => ({}) as AppSettings,
}))
import { listConnections } from './connections'

let handle: TestDatabase
beforeEach(async () => { handle = await createTestDatabase(); state.db = handle.db })
afterEach(async () => { await handle.close() })

const oauth = { accessToken: 'token', refreshToken: 'refresh', expiresAt: 0, accountLabel: 'me@example.com' }
async function insert(id: string, provider: string, config: object) {
  await handle.db.insert(llmConnections).values({
    id, provider, name: id, userId: null, config: JSON.stringify(config), createdAt: new Date(), updatedAt: new Date(),
  }).run()
}

it('marks a subscription whose sign-in the provider rejected as needing reconnection', async () => {
  await insert('revoked', 'grok-subscription', { oauth: { ...oauth, refreshFailure: { reconnectRequired: true, retryAt: 0 } } })
  await insert('transient', 'grok-subscription', { oauth: { ...oauth, refreshFailure: { reconnectRequired: false, retryAt: Date.now() + 30_000 } } })
  await insert('healthy', 'grok-subscription', { oauth })
  await insert('api-key', 'anthropic', { apiKeys: { anthropicApiKey: 'key' } })

  const listed = await listConnections({ userId: null, admin: true })
  const flag = (id: string) => listed.find(connection => connection.id === id)?.reconnectRequired

  expect(['revoked', 'transient', 'healthy', 'api-key'].map(flag)).toEqual([true, false, false, false])
})
