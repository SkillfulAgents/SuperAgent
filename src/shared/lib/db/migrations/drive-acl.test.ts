import { afterEach, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { agents, agentVolumes, user, volumeAcl, volumeDefinitions } from '../schema'
import { migrateFromBundle } from '../open-database'
import { migrationBundle } from './bundle'

let handle: TestDatabase
afterEach(async () => { await handle?.close() })

it('migrates ownership without widening access, including existing global and explicit mounts', async () => {
  const index = migrationBundle.findIndex(m => m.sql.some(s => s.includes('CREATE TABLE `volume_acl`')))
  expect(index).toBeGreaterThan(0)
  handle = await createTestDatabase({ migrations: migrationBundle.slice(0, index) })
  const db = handle.db
  await db.insert(user).values({ id: 'alice', name: 'Alice', email: 'alice@example.org' }).run()
  await db.insert(agents).values({ slug: 'agent', name: 'Agent', createdAt: new Date() }).run()
  await db.run(sql`insert into volume_definitions (id, user_id, name, type, config, global_access, created_at, updated_at)
    values ('private', 'alice', 'My drive', 'future', '{}', null, 1, 2), ('public', null, 'Shared', 'future', '{}', 'read', 3, 4)`)
  await db.insert(agentVolumes).values({ id: 'm1', agentSlug: 'agent', volumeId: 'private', name: 'original-name', readOnly: true, createdAt: new Date(10) }).run()

  await migrateFromBundle(db)
  await migrateFromBundle(db)
  expect(await db.select().from(volumeDefinitions).orderBy(volumeDefinitions.id).all()).toMatchObject([
    { id: 'private', visibility: 'private', createdBy: 'alice' }, { id: 'public', visibility: 'public', globalAccess: 'read' },
  ])
  expect(await db.select().from(volumeAcl).orderBy(volumeAcl.volumeId).all()).toMatchObject([
    { volumeId: 'private', userId: 'alice', role: 'owner' }, { volumeId: 'public', userId: null, role: 'owner' },
  ])
  expect(await db.select().from(agentVolumes).all()).toEqual([
    { id: 'm1', agentSlug: 'agent', volumeId: 'private', name: 'original-name', readOnly: true, createdAt: new Date(10) },
  ])

  // Cascading from the user cannot orphan a drive. Deleting the drive itself clears its children.
  await expect(async () => { await db.delete(user).where(eq(user.id, 'alice')).run() }).rejects.toThrow()
  await expect(async () => { await db.delete(volumeAcl).where(eq(volumeAcl.volumeId, 'private')).run() }).rejects.toThrow()
  await expect(async () => { await db.update(volumeDefinitions).set({ visibility: 'private', globalAccess: null }).where(eq(volumeDefinitions.id, 'public')).run() }).rejects.toThrow()
  await db.delete(volumeDefinitions).where(eq(volumeDefinitions.id, 'private')).run()
  expect(await db.select().from(agentVolumes).all()).toEqual([])
  expect(await db.select().from(volumeAcl).all()).toHaveLength(1)
  await db.delete(user).where(eq(user.id, 'alice')).run()
})

it('requires a real creator for a private drive, a real drive and user for a named grant, and the owner role', async () => {
  handle = await createTestDatabase()
  const db = handle.db
  const drive = { id: 'v', name: 'notes', type: 'local', config: '{}', createdAt: new Date(), updatedAt: new Date() }
  await expect(async () => { await db.insert(volumeDefinitions).values({ ...drive, visibility: 'private' }).run() }).rejects.toThrow()
  await expect(async () => { await db.insert(volumeDefinitions).values({ ...drive, createdBy: 'missing', visibility: 'private' }).run() }).rejects.toThrow()
  await db.insert(user).values({ id: 'alice', name: 'Alice', email: 'alice@example.org' }).run()
  await db.insert(volumeDefinitions).values({ ...drive, createdBy: 'alice', visibility: 'public' }).run()
  const grant = { id: 'grant', volumeId: 'v', userId: 'alice', role: 'owner' as const, createdAt: new Date() }
  for (const invalid of [grant, { ...grant, volumeId: 'missing' }, { ...grant, userId: 'missing' }]) {
    await expect(async () => { await db.insert(volumeAcl).values(invalid).run() }).rejects.toThrow()
  }
  await expect(async () => { await db.run(sql`update volume_acl set role = 'viewer'`) }).rejects.toThrow()
  expect(await db.select().from(volumeAcl).all()).toMatchObject([{ volumeId: 'v', userId: 'alice', role: 'owner' }])
})
