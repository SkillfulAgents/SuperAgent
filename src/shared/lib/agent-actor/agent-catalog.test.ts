import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import * as schema from '@shared/lib/db/schema'

let testDb: ReturnType<typeof drizzle>
let sqlite: InstanceType<typeof Database>
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

import { createAgentCatalog } from './agent-catalog'
import { AGENT_ID_LENGTH, ensureDirectory, getAgentDir, getAgentClaudeMdPath } from '@shared/lib/utils/file-storage'
import type { AgentCatalog } from './types'

let dataDir: string
let previousDataDir: string | undefined
let catalog: AgentCatalog

async function writeAgentDirectory(slug: string, claudeMd: string | null): Promise<void> {
  await ensureDirectory(path.join(getAgentDir(slug), 'workspace'))
  if (claudeMd !== null) await fs.promises.writeFile(getAgentClaudeMdPath(slug), claudeMd)
}

function rowFor(slug: string) {
  return testDb.select().from(schema.agents).where(eq(schema.agents.slug, slug)).get()
}

beforeEach(async () => {
  sqlite = new Database(':memory:')
  testDb = drizzle(sqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
  dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-catalog-test-'))
  previousDataDir = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = dataDir
  catalog = createAgentCatalog()
})

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = previousDataDir
  sqlite.close()
  await fs.promises.rm(dataDir, { recursive: true, force: true })
})

describe('minting and resolving slugs', () => {
  it('mints a bare [a-z0-9] slug that is not derived from any name', async () => {
    const slug = await catalog.mint()
    expect(slug).toMatch(new RegExp(`^[a-z0-9]{${AGENT_ID_LENGTH}}$`))
    expect(await catalog.mint()).not.toBe(slug)
  })

  it('never mints a slug that a directory already uses, even one the table has not imported', async () => {
    // Math.random() -> 0 picks the first character every time, so every
    // random candidate is the same slug; a directory takes it first.
    const collided = 'a'.repeat(AGENT_ID_LENGTH)
    await writeAgentDirectory(collided, null)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      const slug = await catalog.mint()
      expect(slug).not.toBe(collided)
      expect(slug).toMatch(/^[a-z0-9]+$/)
    } finally {
      random.mockRestore()
    }
  })

  it('resolves a slug, a display slug with any prefix, and a legacy compound slug', async () => {
    const slug = await catalog.mint()
    await catalog.insert({ slug, name: 'GPT-4 Bot', createdAt: new Date() })
    await catalog.insert({ slug: 'untitled-h45k3n', name: 'Untitled', createdAt: new Date() })
    await catalog.insert({ slug: 'abc123', name: 'Legacy', createdAt: new Date() })

    expect(await catalog.resolve(slug)).toBe(slug)
    expect(await catalog.resolve(`gpt-4-bot-${slug}`)).toBe(slug)
    expect(await catalog.resolve(`literally-anything-${slug}`)).toBe(slug)
    expect(await catalog.resolve('untitled-h45k3n')).toBe('untitled-h45k3n')
    expect(await catalog.resolve('abc123')).toBe('abc123')
  })

  it('returns null for unknown slugs and for well-formed slugs no agent has', async () => {
    expect(await catalog.resolve('does-not-exist')).toBeNull()
    expect(await catalog.resolve('zzzzzzzzzz')).toBeNull()
    expect(await catalog.resolve(`bot-${'z'.repeat(AGENT_ID_LENGTH)}`)).toBeNull()
  })

  it.each(['../foo', 'a/b', 'a_b', '..', '.', 'foo/../bar', 'UPPER', ''])(
    'rejects unsafe or out-of-charset input %j',
    async (bad) => {
      expect(await catalog.resolve(bad)).toBeNull()
    },
  )
})

describe('records', () => {
  it('lists agents newest first and reads one back with its placement', async () => {
    await catalog.insert({ slug: 'older', name: 'Older', createdAt: new Date('2026-01-01T00:00:00Z') })
    await catalog.insert({
      slug: 'newer', name: 'Newer', description: 'The newer one', createdAt: new Date('2026-02-01T00:00:00Z'),
    })

    expect(await catalog.list()).toEqual(['newer', 'older'])
    expect((await catalog.records()).map((record) => record.slug)).toEqual(['newer', 'older'])
    expect(await catalog.get('newer')).toEqual({
      slug: 'newer',
      name: 'Newer',
      description: 'The newer one',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      placement: { runtime: 'local', workspaceHandle: null },
    })
    expect(await catalog.get('older')).not.toHaveProperty('description')
    expect(await catalog.get('missing')).toBeNull()
    expect(await catalog.exists('older')).toBe(true)
    expect(await catalog.exists('missing')).toBe(false)
  })

  it('returns only the asked-for agents from getMany, newest first, skipping unknown slugs', async () => {
    await catalog.insert({ slug: 'a', name: 'A', createdAt: new Date('2026-01-01T00:00:00Z') })
    await catalog.insert({ slug: 'b', name: 'B', createdAt: new Date('2026-03-01T00:00:00Z') })
    await catalog.insert({ slug: 'c', name: 'C', createdAt: new Date('2026-02-01T00:00:00Z') })

    expect((await catalog.getMany(['a', 'c', 'nope'])).map((record) => record.slug)).toEqual(['c', 'a'])
    expect(await catalog.getMany([])).toEqual([])
  })

  it('updates the name and description, and clears the description with null', async () => {
    await catalog.insert({ slug: 'a', name: 'A', description: 'first', createdAt: new Date() })

    expect((await catalog.update('a', { name: 'Renamed' }))?.name).toBe('Renamed')
    expect((await catalog.get('a'))?.description).toBe('first')
    expect(await catalog.update('a', { description: null })).not.toHaveProperty('description')
    expect(await catalog.update('a', {})).toMatchObject({ name: 'Renamed' })
    expect(await catalog.update('missing', { name: 'x' })).toBeNull()
  })
})

describe('removing an agent', () => {
  it('removes the row and the directory of a local agent', async () => {
    await writeAgentDirectory('gone', '---\nname: Gone\n---\nBody')
    await catalog.insert({ slug: 'gone', name: 'Gone', createdAt: new Date() })

    await catalog.remove('gone')

    expect(rowFor('gone')).toBeUndefined()
    expect(fs.existsSync(getAgentDir('gone'))).toBe(false)
  })

  it('removes only the row of an agent placed elsewhere, and touches no directory', async () => {
    testDb.insert(schema.agents).values({
      slug: 'remote', name: 'Remote', createdAt: new Date(), runtime: 'modal', workspaceHandle: 'superagent-remote',
    }).run()
    await writeAgentDirectory('remote', null)

    await catalog.remove('remote')

    expect(rowFor('remote')).toBeUndefined()
    expect(fs.existsSync(getAgentDir('remote'))).toBe(true)
  })

  it('does nothing for a slug that is not an agent', async () => {
    await writeAgentDirectory('stray', '---\nname: Stray\n---\nBody')
    await catalog.remove('stray')
    expect(fs.existsSync(getAgentDir('stray'))).toBe(true)
  })

  it('keeps the row when the workspace cannot be removed, so the delete can be retried', async () => {
    await writeAgentDirectory('stuck', '---\nname: Stuck\n---\nBody')
    await catalog.insert({ slug: 'stuck', name: 'Stuck', createdAt: new Date() })
    // A directory without write permission refuses to unlink its children.
    const workspace = path.join(getAgentDir('stuck'), 'workspace')
    await fs.promises.chmod(workspace, 0o555)

    try {
      await expect(catalog.remove('stuck')).rejects.toThrow()
      expect(rowFor('stuck')).toBeDefined()
      expect(await catalog.exists('stuck')).toBe(true)
      expect(fs.existsSync(getAgentDir('stuck'))).toBe(true)
    } finally {
      await fs.promises.chmod(workspace, 0o755)
    }

    await catalog.remove('stuck')
    expect(rowFor('stuck')).toBeUndefined()
    expect(fs.existsSync(getAgentDir('stuck'))).toBe(false)
  })
})
