import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { eq, type SQL } from 'drizzle-orm'
import * as schema from '@shared/lib/db/schema'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let testDb: AppDatabase
let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

import { createAgentCatalog, existingAgentSlugsQuery, resolveAgentRecordWithRole, resolveAgentSlugs } from './agent-catalog'
import { setWorkspaceRemoval } from './workspace-removal'
import { agentAvatarSchema } from '@shared/lib/types/agent-avatar'
import * as avatarAssignment from './agent-avatar'
import { AGENT_ID_LENGTH, ensureDirectory, getAgentDir, getAgentInstructionsPath } from '@shared/lib/utils/file-storage'
import type { AgentCatalog } from './types'

let dataDir: string
let previousDataDir: string | undefined
let catalog: AgentCatalog

async function writeAgentDirectory(slug: string, instructions: string | null): Promise<void> {
  await ensureDirectory(path.join(getAgentDir(slug), 'workspace'))
  if (instructions !== null) await fs.promises.writeFile(getAgentInstructionsPath(slug), instructions)
}

async function rowFor(slug: string) {
  return testDb.select().from(schema.agents).where(eq(schema.agents.slug, slug)).get()
}

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-catalog-test-'))
  previousDataDir = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = dataDir
  catalog = createAgentCatalog()
})

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = previousDataDir
  await handle.close()
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
  it('keeps the avatar picked at creation instead of drawing one', async () => {
    const assignment = vi.spyOn(avatarAssignment, 'randomAgentAvatar')
    try {
      const picked = agentAvatarSchema.parse({ color: 'duo-teal-blush', shape: 'hexagon' })
      expect((await catalog.insert({ slug: 'p', name: 'Picked', avatar: picked, createdAt: new Date() })).avatar).toEqual(picked)
      expect(await rowFor('p')).toMatchObject({ avatarColor: picked.color, avatarShape: picked.shape })
      expect(assignment).not.toHaveBeenCalled()
    } finally {
      assignment.mockRestore()
    }
  })

  it('assigns a random pair at insertion and keeps it through reads, renames and picker updates', async () => {
    const first = agentAvatarSchema.parse({ color: 'tonal-red', shape: 'triangle' })
    const second = agentAvatarSchema.parse({ color: 'tonal-teal', shape: 'arch' })
    const assignment = vi.spyOn(avatarAssignment, 'randomAgentAvatar')
      .mockReturnValueOnce(first).mockReturnValueOnce(second)
    try {
      expect((await catalog.insert({ slug: 'a', name: 'Same name', createdAt: new Date() })).avatar).toEqual(first)
      expect((await catalog.insert({ slug: 'b', name: 'Same name', createdAt: new Date() })).avatar).toEqual(second)
      expect((await catalog.get('a'))?.avatar).toEqual(first)
      expect((await catalog.update('a', { name: 'Renamed' }))?.avatar).toEqual(first)
      const chosen = agentAvatarSchema.parse({ color: 'duo-red-amber', shape: 'bloom' })
      await catalog.update('a', { avatar: chosen })
      expect((await createAgentCatalog().get('a'))?.avatar).toEqual(chosen)
      expect(await rowFor('a')).toMatchObject({ avatarColor: chosen.color, avatarShape: chosen.shape })
      expect(assignment).toHaveBeenCalledTimes(2)
    } finally {
      assignment.mockRestore()
    }
  })

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
      avatar: expect.objectContaining({ color: expect.any(String), shape: expect.any(String) }),
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

    expect(await rowFor('gone')).toBeUndefined()
    expect(fs.existsSync(getAgentDir('gone'))).toBe(false)
  })

  it('removes the agent\'s session index, so a later agent with the slug starts without sessions', async () => {
    const sessionsOf = (slug: string) =>
      testDb.select().from(schema.agentSessions).where(eq(schema.agentSessions.agentSlug, slug)).all()
    await writeAgentDirectory('gone', '---\nname: Gone\n---\nBody')
    await catalog.insert({ slug: 'gone', name: 'Gone', createdAt: new Date() })
    await testDb.insert(schema.agentSessions).values([
      { agentSlug: 'gone', sessionId: 's1', metadata: '{"name":"Its session"}' },
      { agentSlug: 'gone', sessionId: 's2', metadata: null, transcriptMtimeMs: 1, transcriptBirthtimeMs: 0, transcriptSize: 1 },
      { agentSlug: 'kept', sessionId: 's1', metadata: '{"name":"Another agent\'s"}' },
    ]).run()

    await catalog.remove('gone')

    expect(await sessionsOf('gone')).toEqual([])
    expect(await sessionsOf('kept')).toHaveLength(1)
  })

  it('removes only the row of an agent placed elsewhere, and touches no directory', async () => {
    await testDb.insert(schema.agents).values({
      slug: 'remote', name: 'Remote', createdAt: new Date(), runtime: 'modal', workspaceHandle: 'superagent-remote',
    }).run()
    await writeAgentDirectory('remote', null)

    await catalog.remove('remote')

    expect(await rowFor('remote')).toBeUndefined()
    expect(fs.existsSync(getAgentDir('remote'))).toBe(true)
  })

  it("removes the workspace the deployment's own way when it set one, and touches no directory", async () => {
    await writeAgentDirectory('hosted', '---\nname: Hosted\n---\nBody')
    await catalog.insert({ slug: 'hosted', name: 'Hosted', createdAt: new Date() })
    const removed: string[] = []
    setWorkspaceRemoval(async (slug) => {
      removed.push(slug)
    })

    try {
      await catalog.remove('hosted')
    } finally {
      setWorkspaceRemoval(null)
    }

    expect(removed).toEqual(['hosted'])
    expect(await rowFor('hosted')).toBeUndefined()
    expect(fs.existsSync(getAgentDir('hosted'))).toBe(true)
  })

  it("keeps the agent when the deployment's removal fails, so the delete can be retried", async () => {
    await catalog.insert({ slug: 'hosted', name: 'Hosted', createdAt: new Date() })
    setWorkspaceRemoval(async () => {
      throw new Error('The workspace store is unavailable')
    })

    try {
      await expect(catalog.remove('hosted')).rejects.toThrow('The workspace store is unavailable')
    } finally {
      setWorkspaceRemoval(null)
    }

    expect(await catalog.exists('hosted')).toBe(true)
  })

  it('does nothing for a slug that is not an agent', async () => {
    await writeAgentDirectory('stray', '---\nname: Stray\n---\nBody')
    await catalog.remove('stray')
    expect(fs.existsSync(getAgentDir('stray'))).toBe(true)
  })

  it('keeps the row when the workspace cannot be removed, so the delete can be retried', async () => {
    await writeAgentDirectory('stuck', '---\nname: Stuck\n---\nBody')
    await catalog.insert({ slug: 'stuck', name: 'Stuck', createdAt: new Date() })
    // A read-only parent refuses to unlink the agent directory itself.
    const agentsDir = path.dirname(getAgentDir('stuck'))
    await fs.promises.chmod(agentsDir, 0o555)

    try {
      await expect(catalog.remove('stuck')).rejects.toThrow()
      expect(await rowFor('stuck')).toBeDefined()
      expect(await catalog.exists('stuck')).toBe(true)
      expect(fs.existsSync(getAgentDir('stuck'))).toBe(true)
    } finally {
      await fs.promises.chmod(agentsDir, 0o755)
    }

    await catalog.remove('stuck')
    expect(await rowFor('stuck')).toBeUndefined()
    expect(fs.existsSync(getAgentDir('stuck'))).toBe(false)
  })
})

describe('reading rows', () => {
  async function insertRow(slug: string, name: string) {
    await testDb.insert(schema.agents).values({
      slug, name, avatarColor: 'tonal-cobalt', avatarShape: 'circle', description: null,
      createdAt: new Date('2026-11-02T12:00:00Z'), runtime: 'local', workspaceHandle: null,
    }).run()
  }

  /** The next row read gets the row at once but answers only when `respond()` runs, like a slow network. */
  function slowNextRead() {
    let respond!: () => void
    const answered = new Promise<void>((resolve) => { respond = resolve })
    const select = testDb.select.bind(testDb)
    vi.spyOn(testDb, 'select').mockImplementationOnce((() => ({
      from: (table: typeof schema.agents) => ({
        where: (filter: SQL) => ({
          get: async () => {
            const row = await select().from(table).where(filter).get()
            await answered
            return row
          },
        }),
      }),
    })) as never)
    return respond
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves a display slug with one query', async () => {
    await insertRow('a1b2c3d4e5', 'Sales')
    const select = vi.spyOn(testDb, 'select')

    expect(await catalog.resolveRecord('sales-a1b2c3d4e5')).toMatchObject({ slug: 'a1b2c3d4e5', name: 'Sales' })
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('resolves a legacy compound slug to itself when the agent its last segment names also exists', async () => {
    await insertRow('a1b2c3d4e5', 'Sales')
    await insertRow('legacy-a1b2c3d4e5', 'Legacy sales')

    expect(await catalog.resolve('legacy-a1b2c3d4e5')).toBe('legacy-a1b2c3d4e5')
    expect(await catalog.resolve('sales-a1b2c3d4e5')).toBe('a1b2c3d4e5')
  })

  describe('with one user\'s role', () => {
    async function insertUser(id: string) {
      await testDb.insert(schema.user).values({ id, name: id, email: `${id}@example.test` }).run()
    }
    async function grant(userId: string, agentSlug: string, role: 'owner' | 'user' | 'viewer') {
      await testDb.insert(schema.agentAcl).values({ id: `${userId}:${agentSlug}`, userId, agentSlug, role, createdAt: new Date(0) }).run()
    }

    it('reads the agent and the role in one statement, for a display slug and for a bare one', async () => {
      await insertRow('a1b2c3d4e5', 'Sales')
      await insertUser('member')
      await insertUser('someone-else')
      await grant('member', 'a1b2c3d4e5', 'user')
      await grant('someone-else', 'a1b2c3d4e5', 'owner')
      const select = vi.spyOn(testDb, 'select')

      const byDisplaySlug = await resolveAgentRecordWithRole('sales-a1b2c3d4e5', 'member')
      expect(byDisplaySlug).toEqual({ agent: await catalog.get('a1b2c3d4e5'), role: 'user' })
      expect(await resolveAgentRecordWithRole('a1b2c3d4e5', 'member')).toEqual(byDisplaySlug)
      // Two resolutions with a role, and the catalog.get() of the expectation.
      expect(select).toHaveBeenCalledTimes(3)
    })

    it('finds the agent with no role for a user who has none on it', async () => {
      await insertRow('a1b2c3d4e5', 'Sales')
      await insertRow('f6g7h8i9j0', 'Research')
      await insertUser('member')
      await grant('member', 'f6g7h8i9j0', 'owner')

      expect(await resolveAgentRecordWithRole('sales-a1b2c3d4e5', 'member')).toMatchObject({ agent: { slug: 'a1b2c3d4e5' }, role: null })
      expect(await resolveAgentRecordWithRole('a1b2c3d4e5', 'nobody')).toMatchObject({ agent: { slug: 'a1b2c3d4e5' }, role: null })
    })

    it('names no agent where resolveRecord names none', async () => {
      await insertRow('a1b2c3d4e5', 'Sales')
      await insertUser('member')
      await grant('member', 'a1b2c3d4e5', 'owner')

      for (const input of ['', 'missing', 'sales-zzzzzzzzzz', '../a1b2c3d4e5', 'Sales-a1b2c3d4e5']) {
        expect(await resolveAgentRecordWithRole(input, 'member')).toBeNull()
        expect(await catalog.resolveRecord(input)).toBeNull()
      }
    })

    it('gives a legacy compound slug its own role, not the role on the agent its last segment names', async () => {
      await insertRow('a1b2c3d4e5', 'Sales')
      await insertRow('legacy-a1b2c3d4e5', 'Legacy sales')
      await insertUser('member')
      await grant('member', 'a1b2c3d4e5', 'owner')
      await grant('member', 'legacy-a1b2c3d4e5', 'viewer')

      expect(await resolveAgentRecordWithRole('legacy-a1b2c3d4e5', 'member')).toMatchObject({ agent: { slug: 'legacy-a1b2c3d4e5' }, role: 'viewer' })
      expect(await resolveAgentRecordWithRole('sales-a1b2c3d4e5', 'member')).toMatchObject({ agent: { slug: 'a1b2c3d4e5' }, role: 'owner' })
    })
  })

  describe('many inputs at once', () => {
    /** What the route did before: one resolve() per distinct input, in the order first given. */
    async function oneByOne(inputs: readonly string[]) {
      const entries: [string, string | null][] = []
      for (const input of new Set(inputs)) entries.push([input, await catalog.resolve(input)])
      return entries
    }

    it('gives every input what resolve() gives it, in the order first asked', async () => {
      await insertRow('a1b2c3d4e5', 'Sales')
      await insertRow('f6g7h8i9j0', 'Research')
      await insertRow('legacy-a1b2c3d4e5', 'Legacy sales')
      await insertRow('private-agent', 'Private')
      const inputs = [
        'sales-a1b2c3d4e5', 'missing', 'a1b2c3d4e5', 'legacy-a1b2c3d4e5', 'sales-a1b2c3d4e5', 'private-agent',
        'research-f6g7h8i9j0', 'sales-zzzzzzzzzz', '../a1b2c3d4e5', 'Sales-a1b2c3d4e5', '', 'a1b2c3d4e5', 'f6g7h8i9j0-', 'x-missing-agent',
      ]

      const resolved = await resolveAgentSlugs(inputs)

      expect([...resolved]).toEqual(await oneByOne(inputs))
      expect(resolved.get('sales-a1b2c3d4e5')).toBe('a1b2c3d4e5')
      expect(resolved.get('legacy-a1b2c3d4e5')).toBe('legacy-a1b2c3d4e5')
      expect(resolved.get('missing')).toBeNull()
      expect(resolved.get('../a1b2c3d4e5')).toBeNull()
    })

    it('is one statement for 1, 5, 50 and 300 inputs, and none when nothing could name an agent', async () => {
      const slugs = Array.from({ length: 150 }, (_, i) => `a${String(i).padStart(AGENT_ID_LENGTH - 1, '0')}`)
      for (const slug of slugs.filter((_, i) => i % 3 !== 0)) await insertRow(slug, slug)
      // Bare slugs, display slugs (two candidates each), unknown and unsafe ones.
      const inputs = slugs.flatMap((slug) => [slug, `name-${slug}`]).concat(['missing', '../x'])
      const select = vi.spyOn(testDb, 'select')

      for (const count of [1, 5, 50, inputs.length]) {
        select.mockClear()
        const resolved = await resolveAgentSlugs(inputs.slice(0, count))
        expect(select).toHaveBeenCalledTimes(1)
        expect(resolved.size).toBe(count)
        expect([...resolved]).toEqual(await oneByOne(inputs.slice(0, count)))
      }

      select.mockClear()
      expect([...await resolveAgentSlugs(['', '../x', 'UPPER'])]).toEqual([['', null], ['../x', null], ['UPPER', null]])
      expect((await resolveAgentSlugs([])).size).toBe(0)
      expect(select).not.toHaveBeenCalled()
    })

    it('binds one parameter however many slugs are asked about', () => {
      const slugs = Array.from({ length: 200 }, (_, i) => `slug-${i}`)
      expect(existingAgentSlugsQuery(slugs).toSQL().params).toEqual([JSON.stringify(slugs)])
    })
  })

  it('reads a rename made through another catalog while an older read is still answering', async () => {
    await insertRow('f6g7h8i9j0', 'Research')
    const otherIsolate = createAgentCatalog()
    const respond = slowNextRead()

    const before = catalog.get('f6g7h8i9j0')
    await otherIsolate.update('f6g7h8i9j0', { name: 'Market research' })
    const after = catalog.get('f6g7h8i9j0')

    respond()
    expect((await before)?.name).toBe('Research')
    expect((await after)?.name).toBe('Market research')
  })
})
