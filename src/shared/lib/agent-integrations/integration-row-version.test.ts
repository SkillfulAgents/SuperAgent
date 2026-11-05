import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
let handle: TestDatabase
let database: AppDatabase
vi.mock('../db', () => ({ get db() { return database } }))
import { eq, sql } from 'drizzle-orm'
import { chatIntegrations } from '../db/schema'
import { createAgentIntegration, getAgentIntegration, updateAgentIntegration, updateAgentIntegrationStatus } from '../services/agent-integration-service'
import { requireIntegrationReconnect } from './lifecycle'

beforeEach(async () => { handle = await createTestDatabase(); database = handle.db })
afterEach(async () => { await handle.close() })

const versionOf = async (id: string) => (await getAgentIntegration(id))!.version

it('moves the row version by exactly one on every write, whoever writes and whatever it changes', async () => {
  const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: '123:old' } })
  expect(await versionOf(id)).toBe(0)
  const writes: Array<[string, () => unknown]> = [
    ['a rename', () => updateAgentIntegration(id, { name: 'Renamed' })],
    ['a status write', () => updateAgentIntegrationStatus(id, 'error', 'Offline')],
    ['a config write that leaves updatedAt alone', () => database.update(chatIntegrations)
      .set({ config: sql`json_set(${chatIntegrations.config}, '$.eventCursor', 5)` }).where(eq(chatIntegrations.id, id)).run()],
    ['raw SQL', () => database.run(sql`update chat_integrations set error_message = 'raw' where id = ${id}`)],
    ['a write that sets the version back', () => database.update(chatIntegrations).set({ version: 0 }).where(eq(chatIntegrations.id, id)).run()],
  ]
  for (const [, write] of writes) {
    const before = await versionOf(id)
    await write()
    expect(await versionOf(id)).toBe(before + 1)
  }
  expect(await versionOf(id)).toBe(writes.length)
})

it('lets the loss raise the version itself and read back exactly the one it produced', async () => {
  const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: '123:old' } })
  await updateAgentIntegration(id, { name: 'Renamed' })
  const before = (await getAgentIntegration(id))!
  expect(await requireIntegrationReconnect({ integrationId: id, expectedConfig: before.config, config: {}, message: 'Reconnect' })).toBe(true)
  expect(await versionOf(id)).toBe(before.version + 1)
})

it('keeps the trigger that moves it in a migrated database', async () => {
  const trigger = await database.get<{ name: string }>(sql`select name from sqlite_master where type = 'trigger' and tbl_name = 'chat_integrations' and name = 'chat_integrations_version_bump'`)
  expect(trigger?.name).toBe('chat_integrations_version_bump')
})
