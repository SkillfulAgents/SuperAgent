import { afterEach, beforeEach, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { chatIntegrations, integrationState } from '../schema'
import { migrationBundle } from './bundle'
let handle: TestDatabase
beforeEach(async () => {
  handle = await createTestDatabase()
  // Reconstruct only the two predecessor tables, then execute the shipped upgrade.
  await handle.db.run(sql`DROP TABLE integration_state`)
  for (const index of [45, 48]) {
    for (const statement of migrationBundle[index].sql) await handle.db.run(sql.raw(statement))
  }
  for (const [id, provider] of [['email', 'platform-email'], ['slack', 'slack']] as const) {
    await handle.db.insert(chatIntegrations).values({ id, agentSlug: id, provider, config: '{}', createdAt: new Date(), updatedAt: new Date() }).run()
  }
})
afterEach(async () => { await handle.close() })
it('preserves opaque email state, retry scheduling and Slack bot participation, then drops both private tables', async () => {
  const job = JSON.stringify({ parentId: 'message', parts: ['Answer'], attachmentIds: ['attachment'], draft: { action: 'send', text: 'Saved draft' }, retryAfter: 123 })
  await handle.db.run(sql`INSERT INTO email_integration_state (integration_id, key, value) VALUES ('email', 'cursor', '42'), ('email', 'reply-job:pending', ${job})`)
  await handle.db.run(sql`INSERT INTO slack_thread_state (integration_id, bot_user_id, active_threads) VALUES ('slack', 'BOT', '["C1|1.0","C2|2.0"]')`)
  for (const statement of migrationBundle[49].sql) await handle.db.run(sql.raw(statement))
  expect(await handle.db.select().from(integrationState).all()).toEqual(expect.arrayContaining([
    { integrationId: 'email', key: 'cursor', value: '42', availableAt: null },
    { integrationId: 'email', key: 'reply-job:pending', value: job, availableAt: 123 },
    { integrationId: 'slack', key: 'slack:participation', value: JSON.stringify({ botUserId: 'BOT', activeThreads: ['C1|1.0', 'C2|2.0'] }), availableAt: null },
  ]))
  const old = await handle.db.get(sql`SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('email_integration_state','slack_thread_state')`)
  expect(old).toEqual({ count: 0 })
})
