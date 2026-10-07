import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { agents, agentAcl, agentVolumes, user, volumeDefinitions } from '../schema'
import { importVolumeDefinitions, legacyVolumeId } from './0006-import-volume-definitions'

let handle: TestDatabase
let dataDir: string
beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-migration-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  handle = await createTestDatabase()
})
afterEach(async () => {
  await handle.close()
  vi.unstubAllEnvs()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
async function addAgent(slug: string, rows: unknown[], owner?: string) {
  await handle.db.insert(agents).values({ slug, name: slug, createdAt: new Date() }).run()
  if (owner) {
    await handle.db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.com` }).onConflictDoNothing().run()
    await handle.db.insert(agentAcl).values({ id: slug, userId: owner, agentSlug: slug, role: 'owner', createdAt: new Date() }).run()
  }
  const file = path.join(dataDir, 'agents', slug, 'mounts.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(z.array(z.json()).parse(rows)))
  return file
}

describe('import volume definitions', () => {
  it('imports both legacy shapes, preserving mount identity, path and original file', async () => {
    const file = await addAgent('a', [
      { id: 'old', hostPath: '/missing/disk', containerPath: '/mounts/notes-2', folderName: 'notes' },
      { id: 'typed', name: 'projects', type: 'local', config: { path: '/projects' } },
    ], 'alice')
    const original = fs.readFileSync(file, 'utf8')
    await importVolumeDefinitions.run(handle.db)
    expect(await handle.db.select().from(agentVolumes).orderBy(agentVolumes.id).all()).toMatchObject([
      { id: 'old', name: 'notes-2', agentSlug: 'a', volumeId: legacyVolumeId('a', 'old') },
      { id: 'typed', name: 'projects', volumeId: legacyVolumeId('a', 'typed') },
    ])
    const definitions = await handle.db.select().from(volumeDefinitions).orderBy(volumeDefinitions.name).all()
    expect(definitions).toMatchObject([{ userId: 'alice', name: 'notes-2', type: 'local' }, { userId: 'alice', name: 'projects', type: 'local' }])
    expect(z.object({ path: z.string() }).parse(JSON.parse(definitions[0].config))).toEqual({ path: '/missing/disk' })
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
  })
  it('keeps identical legacy IDs from different agents and owners separate', async () => {
    const rows = [{ id: 'copied', name: 'notes', type: 'local', config: { path: '/notes' } }]
    await addAgent('a', rows, 'alice')
    await addAgent('b', rows, 'bob')
    await addAgent('local', rows)
    await importVolumeDefinitions.run(handle.db)
    const definitions = await handle.db.select().from(volumeDefinitions).all()
    expect(new Set(definitions.map(v => v.id)).size).toBe(3)
    expect(definitions.map(v => v.userId).sort()).toEqual(['alice', 'bob', null].sort())
    expect(await handle.db.select().from(agentVolumes).all()).toHaveLength(3)
  })
  it('repairs partial imports on retry without overwriting a renamed source', async () => {
    await addAgent('a', [{ id: 'old', name: 'notes', type: 'local', config: { path: '/notes' } }])
    await importVolumeDefinitions.run(handle.db)
    await handle.db.delete(agentVolumes).run()
    await handle.db.update(volumeDefinitions).set({ name: 'User rename' }).run()
    await importVolumeDefinitions.run(handle.db)
    await importVolumeDefinitions.run(handle.db)
    expect(await handle.db.select().from(volumeDefinitions).all()).toMatchObject([{ name: 'User rename' }])
    expect(await handle.db.select().from(agentVolumes).all()).toMatchObject([{ id: 'old', name: 'notes' }])
  })
  it('preserves future types, skips invalid rows and retains corrupt files for recovery', async () => {
    await addAgent('good', [{ id: 'future', name: 'cloud', type: 'future', config: { account: 'a' } }, null])
    const corrupt = await addAgent('corrupt', [])
    fs.writeFileSync(corrupt, '[broken')
    const absent = await addAgent('absent', [])
    fs.unlinkSync(absent)
    await expect(importVolumeDefinitions.run(handle.db)).resolves.toBeUndefined()
    expect(await handle.db.select().from(volumeDefinitions).all()).toMatchObject([{ type: 'future' }])
    expect(fs.readFileSync(corrupt, 'utf8')).toBe('[broken')
    expect(await handle.db.select().from(agentVolumes).where(eq(agentVolumes.agentSlug, 'corrupt')).all()).toEqual([])
  })
})
