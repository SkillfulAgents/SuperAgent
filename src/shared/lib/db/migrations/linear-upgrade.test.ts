import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { migrationBundle } from './bundle'
import { chatIntegrations, integrationTaskEvents, linearIssueCursors, mcpAuditLog } from '../schema'

let handle: TestDatabase | undefined
afterEach(async () => { await handle?.close() })

// Earlier PR builds applied these stages separately. The final migration must
// upgrade every stage without replacing existing rows or replaying side effects.
describe('consolidated Linear migration', () => {
  it.each([0, 1, 2, 3])('preserves data after previous PR migration stage %i', async stage => {
    handle = await createTestDatabase()
    const db = handle.db
    const migration = migrationBundle.find(entry => entry.sql.some(statement => statement.includes('CREATE TABLE IF NOT EXISTS `integration_task_events`')))!
    const previousTimestamps = [1789590527958, 1789603289009, 1790010549802]
    expect(migration.folderMillis).toBeGreaterThan(previousTimestamps.at(-1)!)
    if (stage < 2) await db.run(sql`drop table linear_issue_sync`)
    if (stage < 1) await db.run(sql`drop table integration_task_events`)
    else await db.run(sql`alter table integration_task_events drop column dispatch_attempts`)
    if (stage === 3) await db.run(sql`alter table mcp_audit_log add integration_id text`)

    const now = new Date()
    await db.insert(chatIntegrations).values({ id: 'kept', agentSlug: 'test', provider: 'linear', config: '{"credential":"unchanged"}', createdAt: now, updatedAt: now })
    await db.insert(mcpAuditLog).values({ id: 'audit', agentSlug: 'test', remoteMcpId: 'integration:kept', remoteMcpName: 'Test', method: 'POST', requestPath: 'tools/call', createdAt: now })
    if (stage >= 1) await db.run(sql`insert into integration_task_events
      (id, integration_id, external_event_id, task_id, interaction_id, event_json, created_at, updated_at)
      values ('queued', 'kept', 'event', 'task', 'thread', '{}', ${now.getTime()}, ${now.getTime()})`)
    if (stage >= 2) await db.insert(linearIssueCursors).values({ integrationId: 'kept', taskId: 'task', firstSeenAt: now.toISOString(), syncedThrough: now.toISOString(), nextPollAt: now })

    for (const statement of migration.sql) await db.run(sql.raw(statement))
    const retryMigration = migrationBundle.find(entry => entry.sql.some(statement => statement.includes('ADD `dispatch_attempts`')))!
    for (const statement of retryMigration.sql) await db.run(sql.raw(statement))
    const firstLedger = await db.all(sql`select * from __drizzle_migrations`)
    for (const statement of migration.sql) await db.run(sql.raw(statement))
    expect(await db.all(sql`select * from __drizzle_migrations`)).toEqual(firstLedger)
    expect(await db.select().from(chatIntegrations)).toMatchObject([{ id: 'kept', config: '{"credential":"unchanged"}' }])
    expect(await db.select().from(mcpAuditLog)).toMatchObject([{ id: 'audit', remoteMcpId: 'integration:kept' }])
    const preserved = await db.select().from(integrationTaskEvents)
    expect(preserved).toHaveLength(stage >= 1 ? 1 : 0)
    if (stage >= 1) expect(preserved[0]).toMatchObject({ id: 'queued', dispatchAttempts: 0 })
    expect(await db.select().from(linearIssueCursors)).toHaveLength(stage >= 2 ? 1 : 0)
    // The upgraded tables remain writable even when they existed before migration.
    await db.insert(integrationTaskEvents).values({ id: 'next', integrationId: 'kept', externalEventId: 'next', taskId: 'task', interactionId: 'thread', eventJson: '{}', createdAt: now, updatedAt: now })
  })
})
