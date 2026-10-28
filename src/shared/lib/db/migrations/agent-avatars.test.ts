import { afterEach, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { agentAvatarSchema } from '@shared/lib/types/agent-avatar'
import { localVolumeConfigSchema } from '@shared/lib/volumes/volume-config-schema'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { migrateFromBundle } from '../open-database'
import { agents, agentVolumes } from '../schema'
import { migrationBundle } from './bundle'

let handle: TestDatabase | undefined
afterEach(async () => { await handle?.close() })

it('backfills old agents, preserves referenced rows, and never rerandomizes on later boots', async () => {
  const avatarMigration = migrationBundle.findIndex(m => m.sql.some(s => s.includes('ADD `avatar_color`')))
  expect(avatarMigration).toBeGreaterThan(0)
  handle = await createTestDatabase({ migrations: migrationBundle.slice(0, avatarMigration) })
  const db = handle.db
  for (let i = 0; i < 32; i++) {
    await db.run(sql`INSERT INTO agents (slug, name, created_at) VALUES (${`old-${i}`}, ${`Agent ${i}`}, 1)`)
  }
  // Seed historical columns explicitly: the current schema also includes later additions.
  await db.run(sql`INSERT INTO volume_definitions (id, name, type, config, created_at, updated_at)
    VALUES ('volume', 'Files', 'local', ${JSON.stringify(localVolumeConfigSchema.parse({ path: '/tmp/avatar-migration-fixture' }))}, 1, 1)`)
  await db.run(sql`INSERT INTO agent_volumes (id, agent_slug, volume_id, name, created_at)
    VALUES ('mount', 'old-0', 'volume', 'Files', 1)`)

  await migrateFromBundle(db)
  const migrated = await db.select().from(agents).all()
  expect(migrated).toHaveLength(32)
  for (const row of migrated) {
    expect(agentAvatarSchema.safeParse({ color: row.avatarColor, shape: row.avatarShape }).success).toBe(true)
  }
  expect(new Set(migrated.map(row => `${row.avatarColor}:${row.avatarShape}`)).size).toBeGreaterThan(1)
  expect(await db.select().from(agentVolumes).all()).toMatchObject([{ id: 'mount', readOnly: false }])

  await db.update(agents).set({ avatarColor: 'duo-red-amber', avatarShape: 'bloom' }).where(eq(agents.slug, 'old-0')).run()
  const saved = await db.select().from(agents).all()
  await migrateFromBundle(db)
  expect(await db.select().from(agents).all()).toEqual(saved)
})

it('rejects null color and shape at the database boundary', async () => {
  handle = await createTestDatabase()
  const db = handle.db
  await db.insert(agents).values({ slug: 'agent', name: 'Agent', createdAt: new Date() }).run()
  await expect((async () => { await db.run(sql`UPDATE agents SET avatar_color = NULL WHERE slug = 'agent'`) })()).rejects.toThrow()
  await expect((async () => { await db.run(sql`UPDATE agents SET avatar_shape = NULL WHERE slug = 'agent'`) })()).rejects.toThrow()
})
