import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { migrationBundle } from './bundle'
import { migrateFromBundle } from '../open-database'
import { chatIntegrations, integrationTaskEvents, mcpAuditLog } from '../schema'

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
    if (stage < 1) await db.run(sql`drop table integration_task_events`)
    else await db.run(sql`alter table integration_task_events drop column dispatch_attempts`)
    if (stage === 3) await db.run(sql`alter table mcp_audit_log add integration_id text`)

    const now = new Date()
    await db.insert(chatIntegrations).values({ id: 'kept', agentSlug: 'test', provider: 'linear', config: '{"credential":"unchanged"}', createdAt: now, updatedAt: now })
    await db.insert(mcpAuditLog).values({ id: 'audit', agentSlug: 'test', remoteMcpId: 'integration:kept', remoteMcpName: 'Test', method: 'POST', requestPath: 'tools/call', createdAt: now })
    if (stage >= 1) await db.run(sql`insert into integration_task_events
      (id, integration_id, external_event_id, task_id, interaction_id, event_json, created_at, updated_at)
      values ('queued', 'kept', 'event', 'task', 'thread', '{}', ${now.getTime()}, ${now.getTime()})`)
    if (stage >= 2) {
      for (const statement of migration.sql.filter(statement => statement.includes('linear_issue_sync'))) await db.run(sql.raw(statement))
      await db.run(sql`insert into linear_issue_sync (integration_id, task_id, first_seen_at, synced_through, next_poll_at) values ('kept', 'task', ${now.toISOString()}, ${now.toISOString()}, ${now.getTime()})`)
    }

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
    const removal = migrationBundle.find(entry => entry.sql.some(statement => statement.includes('DROP TABLE IF EXISTS `linear_issue_sync`')))!
    for (const statement of removal.sql) await db.run(sql.raw(statement))
    for (const statement of removal.sql) await db.run(sql.raw(statement))
    expect(await db.all(sql`select name from sqlite_master where type = 'table' and name = 'linear_issue_sync'`)).toEqual([])
    expect(await db.select().from(integrationTaskEvents)).toHaveLength(stage >= 1 ? 1 : 0)
    // The upgraded tables remain writable even when they existed before migration.
    await db.insert(integrationTaskEvents).values({ id: 'next', integrationId: 'kept', externalEventId: 'next', taskId: 'task', interactionId: 'thread', eventJson: '{}', createdAt: now, updatedAt: now })
  })
})


// createTestDatabase always opens a private :memory: database. Reconstruct old
// schema/ledger states there to exercise the real timestamp-based boot migrator.
it.each(['base', 'legacy-create', 'legacy-retry', 'legacy-live', 'legacy-live-on-base'])('upgrades %s through the rebased bundle without losing work', async version => {
  handle = await createTestDatabase()
  const db = handle.db
  const onBase = version === 'base' || version === 'legacy-live-on-base'
  const hasTasks = version !== 'base'
  const hasAttempts = hasTasks && version !== 'legacy-create'
  if (!onBase) {
    await db.run(sql`ALTER TABLE scheduled_tasks DROP COLUMN consecutive_skips`)
    await db.run(sql`ALTER TABLE scheduled_tasks DROP COLUMN last_skipped_at`)
  }
  if (!hasTasks) await db.run(sql`DROP TABLE integration_task_events`)
  else if (!hasAttempts) await db.run(sql`ALTER TABLE integration_task_events DROP COLUMN dispatch_attempts`)

  const now = new Date()
  await db.insert(chatIntegrations).values({ id: 'kept', agentSlug: 'test', provider: 'linear', config: '{"credential":"unchanged"}', createdAt: now, updatedAt: now })
  if (hasTasks) {
    await db.run(sql`INSERT INTO integration_task_events
      (id, integration_id, external_event_id, task_id, interaction_id, event_json, created_at, updated_at)
      VALUES ('queued', 'kept', 'event', 'task', 'thread', '{}', ${now.getTime()}, ${now.getTime()})`)
    if (hasAttempts) await db.run(sql`UPDATE integration_task_events SET dispatch_attempts = 2 WHERE id = 'queued'`)
  }
  const taskMigration = migrationBundle.findIndex(entry => entry.sql.some(statement => statement.includes('CREATE TABLE IF NOT EXISTS `integration_task_events`')))
  const baseMigration = taskMigration - 1
  const lastLegacy = version === 'legacy-create' ? taskMigration : version === 'legacy-retry' ? taskMigration + 1 : taskMigration + 2
  // Restore the ledger each actual release would have left. Historical SQL hashes
  // and timestamps are retained across the rebase even though filenames moved.
  await db.run(sql`DELETE FROM __drizzle_migrations`)
  for (const [index, entry] of migrationBundle.entries()) {
    if (index < baseMigration || (onBase && index === baseMigration) || (hasTasks && index >= taskMigration && index <= lastLegacy)) {
      await db.run(sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${entry.hash}, ${entry.folderMillis})`)
    }
  }
  await migrateFromBundle(db)
  const ledger = await db.all(sql`SELECT * FROM __drizzle_migrations`)
  await migrateFromBundle(db)
  expect(await db.all(sql`SELECT * FROM __drizzle_migrations`)).toEqual(ledger)
  expect(await db.select().from(chatIntegrations)).toMatchObject([{ id: 'kept', config: '{"credential":"unchanged"}' }])
  expect(await db.select().from(integrationTaskEvents)).toEqual(hasTasks ? [expect.objectContaining({ id: 'queued', dispatchAttempts: hasAttempts ? 2 : 0 })] : [])
  const scheduledColumns = await db.all<{ name: string }>(sql`PRAGMA table_info(scheduled_tasks)`)
  expect(scheduledColumns.map(column => column.name)).toEqual(expect.arrayContaining(['consecutive_skips', 'last_skipped_at']))
  expect(await db.all(sql`SELECT name FROM sqlite_master WHERE name = 'linear_issue_sync'`)).toEqual([])
})
