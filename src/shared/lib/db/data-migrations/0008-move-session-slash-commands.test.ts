import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { agents } from '../schema'
import { runDataMigrations } from './index'
import { moveSessionSlashCommands, moveSessionSlashCommandsMigration } from './0008-move-session-slash-commands'

let handle: TestDatabase
let dataDir: string

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'slash-commands-migration-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  handle = await createTestDatabase()
})

afterEach(async () => {
  await handle.close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function addAgent(slug: string, files: Record<string, unknown>): Promise<string> {
  await handle.db.insert(agents).values({ slug, name: slug, createdAt: new Date(), runtime: 'local', workspaceHandle: null }).run()
  const workspace = path.join(dataDir, 'agents', slug, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(workspace, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  return workspace
}

const readJson = (workspace: string, name: string) => JSON.parse(fs.readFileSync(path.join(workspace, name), 'utf-8'))
const older = [{ name: 'deploy', description: 'Ship it', argumentHint: '' }]
const newer = [...older, { name: 'review', description: 'Review it', argumentHint: '' }]

describe('move-session-slash-commands', () => {
  it('drops every session copy and keeps the newest as the agent copy', async () => {
    const workspace = await addAgent('shop-reports', {
      'session-metadata.json': {
        'scheduled-run': { name: 'Slow orders check', createdAt: '2026-10-01T00:00:00Z', isScheduledExecution: true, slashCommands: older },
        'user-chat': { name: 'User chat', createdAt: '2026-10-20T00:00:00Z', starred: true, slashCommands: newer },
        'plain-chat': { name: 'Plain chat', createdAt: '2026-10-25T00:00:00Z' },
      },
    })

    expect(await moveSessionSlashCommands(handle.db)).toEqual(['shop-reports'])

    expect(readJson(workspace, 'session-metadata.json')).toEqual({
      'scheduled-run': { name: 'Slow orders check', createdAt: '2026-10-01T00:00:00Z', isScheduledExecution: true },
      'user-chat': { name: 'User chat', createdAt: '2026-10-20T00:00:00Z', starred: true },
      'plain-chat': { name: 'Plain chat', createdAt: '2026-10-25T00:00:00Z' },
    })
    expect(readJson(workspace, '.slash-commands.json')).toEqual(newer)
  })

  it('keeps an agent copy that already exists', async () => {
    const workspace = await addAgent('agent', {
      '.slash-commands.json': newer,
      'session-metadata.json': { 'user-chat': { name: 'User chat', createdAt: '2026-10-20T00:00:00Z', slashCommands: older } },
    })

    expect(await moveSessionSlashCommands(handle.db)).toEqual(['agent'])

    expect(readJson(workspace, 'session-metadata.json')).toEqual({ 'user-chat': { name: 'User chat', createdAt: '2026-10-20T00:00:00Z' } })
    expect(readJson(workspace, '.slash-commands.json')).toEqual(newer)
  })

  it('leaves clean, empty and missing metadata untouched', async () => {
    const clean = await addAgent('clean', { 'session-metadata.json': { 'user-chat': { name: 'User chat' } } })
    const before = fs.statSync(path.join(clean, 'session-metadata.json'))
    const empty = await addAgent('empty', {})

    expect(await moveSessionSlashCommands(handle.db)).toEqual([])

    const after = fs.statSync(path.join(clean, 'session-metadata.json'))
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs })
    expect(fs.readdirSync(empty)).toEqual([])
    expect(fs.existsSync(path.join(clean, '.slash-commands.json'))).toBe(false)
  })

  it('skips an agent with corrupt metadata without rewriting it, and migrates the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const corrupt = await addAgent('corrupt', { 'session-metadata.json': '{ "user-chat": { ' })
    await addAgent('busy', { 'session-metadata.json': { 'run': { name: 'Run', slashCommands: older } } })

    expect(await moveSessionSlashCommands(handle.db)).toEqual(['busy'])

    expect(fs.readFileSync(path.join(corrupt, 'session-metadata.json'), 'utf-8')).toBe('{ "user-chat": { ')
  })

  it('finds nothing left on a re-run after a crash before the ledger write', async () => {
    const workspace = await addAgent('agent', {
      'session-metadata.json': { 'run': { name: 'Run', createdAt: '2026-10-01T00:00:00Z', slashCommands: older } },
    })

    await moveSessionSlashCommandsMigration.run(handle.db)
    const cleaned = fs.readFileSync(path.join(workspace, 'session-metadata.json'), 'utf-8')
    expect(await runDataMigrations(handle.db, [moveSessionSlashCommandsMigration])).toEqual([8])
    expect(fs.readFileSync(path.join(workspace, 'session-metadata.json'), 'utf-8')).toBe(cleaned)
    expect(readJson(workspace, '.slash-commands.json')).toEqual(older)
    expect(await runDataMigrations(handle.db, [moveSessionSlashCommandsMigration])).toEqual([])
  })
})
