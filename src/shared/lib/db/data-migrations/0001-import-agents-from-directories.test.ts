import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../schema'
import { importAgentDirectories, importAgentsFromDirectories } from './0001-import-agents-from-directories'
import { runDataMigrations } from './index'
import { identityFromInstructions } from '@shared/lib/agent-actor/agent-directories'

let sqlite: InstanceType<typeof Database>
let db: ReturnType<typeof drizzle<typeof schema>>
let dataDir: string
let previousDataDir: string | undefined

function writeAgentDirectory(slug: string, claudeMd: string | null): void {
  const workspace = path.join(dataDir, 'agents', slug, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  if (claudeMd !== null) fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), claudeMd)
}

function rows() {
  return db.select().from(schema.agents).orderBy(schema.agents.slug).all()
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/shared/lib/db/migrations' })
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-agents-migration-'))
  previousDataDir = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = dataDir
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = previousDataDir
  sqlite.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('import-agents-from-directories', () => {
  it('imports every directory with a CLAUDE.md, named from its frontmatter, and ignores the rest', () => {
    writeAgentDirectory('imported', [
      '---',
      'name: Imported Agent',
      'description: Came from disk',
      'createdAt: "2026-01-24T01:30:50.090Z"',
      '---',
      'Body',
    ].join('\n'))
    writeAgentDirectory('hollow', null)
    fs.writeFileSync(path.join(dataDir, 'agents', 'stray-file'), 'not an agent')

    expect(importAgentDirectories(db)).toEqual(['imported'])

    expect(rows()).toEqual([{
      slug: 'imported',
      name: 'Imported Agent',
      description: 'Came from disk',
      createdAt: new Date('2026-01-24T01:30:50.090Z'),
      runtime: 'local',
      workspaceHandle: null,
    }])
  })

  it('falls back to the slug for a missing name and to the directory birth time for a missing date', () => {
    const before = Date.now() - 1000
    writeAgentDirectory('bare', 'No frontmatter at all')
    writeAgentDirectory('numbered', '---\nname: 123\n---\nBody')

    importAgentDirectories(db)

    const [bare, numbered] = rows()
    expect(bare.name).toBe('bare')
    expect(bare.description).toBeNull()
    expect(bare.createdAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(bare.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
    expect(numbered.name).toBe('123')
  })

  it('leaves directories the table already knows alone, so re-running is safe', () => {
    writeAgentDirectory('known', '---\nname: On Disk\n---\nBody')
    db.insert(schema.agents).values({ slug: 'known', name: 'In The Table', createdAt: new Date() }).run()

    expect(importAgentDirectories(db)).toEqual([])
    expect(rows()[0].name).toBe('In The Table')
  })

  it('does nothing when there is no agents directory yet', () => {
    expect(importAgentDirectories(db)).toEqual([])
    expect(rows()).toEqual([])
  })

  it('runs as data migration 1 and is recorded in the ledger', () => {
    writeAgentDirectory('first', '---\nname: First\n---\nBody')

    expect(runDataMigrations(db, [importAgentsFromDirectories])).toEqual([1])

    expect(rows().map((row) => row.slug)).toEqual(['first'])
    expect(db.select().from(schema.dataMigrations).all()).toMatchObject([{ id: 1, name: 'import-agents-from-directories' }])
    // A directory added afterwards is not imported by a later boot.
    writeAgentDirectory('later', '---\nname: Later\n---\nBody')
    expect(runDataMigrations(db, [importAgentsFromDirectories])).toEqual([])
    expect(rows().map((row) => row.slug)).toEqual(['first'])
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
