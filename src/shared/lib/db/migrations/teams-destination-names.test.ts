import { sql } from 'drizzle-orm'
import { afterEach, expect, it } from 'vitest'
import { migrateFromBundle } from '../open-database'
import { chatIntegrationAccess, teamsConversationReferences } from '../schema'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { migrationBundle } from './bundle'

let handle: TestDatabase
afterEach(async () => { await handle?.close() })

it('preserves each installed Teams app’s destination names and keeps Telegram approvals', async () => {
  const index = migrationBundle.findIndex(m => m.sql.some(s => s.includes('ALTER TABLE `teams_conversation_references` ADD `display_name`')))
  expect(index).toBeGreaterThan(0)
  handle = await createTestDatabase({ migrations: migrationBundle.slice(0, index) })
  const db = handle.db
  await db.run(sql`INSERT INTO chat_integrations (id, agent_slug, provider, config, created_at, updated_at) VALUES
    ('teams-a', 'support', 'teams', '{}', 1, 1),
    ('teams-b', 'release', 'teams', '{}', 1, 1),
    ('telegram', 'support', 'telegram', '{}', 1, 1)`)
  await db.run(sql`INSERT INTO teams_conversation_references
    (integration_id, external_id, tenant_id, app_id, service_url, conversation_id, scope_id, scope_type, originator_id) VALUES
    ('teams-a', 'channel', 'tenant-a', 'app-a', 'https://service.test', 'channel', 'channel', 'channel', 'sender'),
    ('teams-a', 'personal', 'tenant-a', 'app-a', 'https://service.test', 'personal', 'personal', 'personal', 'sender'),
    ('teams-b', 'channel', 'tenant-b', 'app-b', 'https://service.test', 'channel', 'channel', 'channel', 'sender')`)
  await db.run(sql`INSERT INTO chat_integration_access
    (id, integration_id, external_chat_id, status, title, first_user_name, requested_at, created_at, updated_at) VALUES
    ('a-channel', 'teams-a', 'channel', 'allowed', 'Support', 'Ada', 1, 1, 1),
    ('a-dm', 'teams-a', 'personal', 'pending', NULL, 'Ada', 1, 1, 1),
    ('b-channel', 'teams-b', 'channel', 'pending', NULL, 'Bob', 1, 1, 1),
    ('tg-dm', 'telegram', 'personal', 'denied', NULL, 'Charlie', 1, 1, 1)`)

  await migrateFromBundle(db)
  const refs = teamsConversationReferences
  expect(await db.select({ integration: refs.integrationId, chat: refs.externalId, name: refs.displayName })
    .from(refs).orderBy(refs.integrationId, refs.externalId).all()).toEqual([
    { integration: 'teams-a', chat: 'channel', name: 'Support' },
    { integration: 'teams-a', chat: 'personal', name: 'Ada' },
    { integration: 'teams-b', chat: 'channel', name: null },
  ])
  expect(await db.select({ id: chatIntegrationAccess.id, status: chatIntegrationAccess.status })
    .from(chatIntegrationAccess).all()).toEqual([{ id: 'tg-dm', status: 'denied' }])
})
