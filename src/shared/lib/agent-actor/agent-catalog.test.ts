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

import { createAgentCatalog, identityFromInstructions } from './agent-catalog'
import { AGENT_ID_LENGTH, ensureDirectory, getAgentDir, getAgentsDir, getAgentClaudeMdPath } from '@shared/lib/utils/file-storage'
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
})

describe('reconciling with the agents directory', () => {
  it('imports a directory with a CLAUDE.md as a local agent named from its frontmatter', async () => {
    await writeAgentDirectory('imported', [
      '---',
      'name: Imported Agent',
      'description: Came from disk',
      'createdAt: "2026-01-24T01:30:50.090Z"',
      '---',
      'Body',
    ].join('\n'))

    const result = await catalog.reconcile()

    expect(result).toEqual({ imported: ['imported'], removed: [] })
    expect(await catalog.get('imported')).toEqual({
      slug: 'imported',
      name: 'Imported Agent',
      description: 'Came from disk',
      createdAt: new Date('2026-01-24T01:30:50.090Z'),
      placement: { runtime: 'local', workspaceHandle: null },
    })
  })

  it('falls back to the slug for a missing name and to the directory birth time for a missing date', async () => {
    await writeAgentDirectory('bare', 'No frontmatter at all')
    const before = Date.now() - 1000

    await catalog.reconcile()

    const record = await catalog.get('bare')
    expect(record?.name).toBe('bare')
    expect(record).not.toHaveProperty('description')
    expect(record!.createdAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(record!.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('coerces a name the frontmatter parser turned into a number', async () => {
    await writeAgentDirectory('numbered', '---\nname: 123\n---\nBody')
    await catalog.reconcile()
    expect((await catalog.get('numbered'))?.name).toBe('123')
  })

  it('skips a directory without a CLAUDE.md and leaves an existing row alone', async () => {
    await writeAgentDirectory('hollow', null)
    await writeAgentDirectory('known', '---\nname: On Disk\n---\nBody')
    await catalog.insert({ slug: 'known', name: 'In The Table', createdAt: new Date() })

    const result = await catalog.reconcile()

    expect(result).toEqual({ imported: [], removed: [] })
    expect(await catalog.exists('hollow')).toBe(false)
    expect((await catalog.get('known'))?.name).toBe('In The Table')
  })

  it('removes a local row whose directory is gone and keeps a row placed elsewhere', async () => {
    await catalog.insert({ slug: 'vanished', name: 'Vanished', createdAt: new Date() })
    testDb.insert(schema.agents).values({
      slug: 'remote', name: 'Remote', createdAt: new Date(), runtime: 'modal', workspaceHandle: 'superagent-remote',
    }).run()
    await ensureDirectory(getAgentsDir())

    const result = await catalog.reconcile()

    expect(result).toEqual({ imported: [], removed: ['vanished'] })
    expect(await catalog.exists('vanished')).toBe(false)
    expect((await catalog.get('remote'))?.placement).toEqual({ runtime: 'modal', workspaceHandle: 'superagent-remote' })
  })

  it('creates the agents directory when it does not exist yet', async () => {
    expect(await catalog.reconcile()).toEqual({ imported: [], removed: [] })
    expect(fs.existsSync(getAgentsDir())).toBe(true)
  })
})

describe('identityFromInstructions', () => {
  it('reads name, description and a valid date, and leaves out what is absent or blank', () => {
    expect(identityFromInstructions('---\nname: A\ndescription: B\ncreatedAt: "2026-01-01T00:00:00.000Z"\n---\nBody'))
      .toEqual({ name: 'A', description: 'B', createdAt: new Date('2026-01-01T00:00:00.000Z') })
    expect(identityFromInstructions('---\nname:\ndescription:   \ncreatedAt: not-a-date\n---\nBody')).toEqual({})
    expect(identityFromInstructions('Body only')).toEqual({})
  })
})
