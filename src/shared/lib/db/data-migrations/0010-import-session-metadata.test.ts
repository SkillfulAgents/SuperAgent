import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { agents, agentSessions } from '../schema'
import { runDataMigrations } from './index'
import { importSessionMetadata, importSessionMetadataMigration } from './0010-import-session-metadata'

let handle: TestDatabase
let dataDir: string

// The app's own handle is the migration's here: what the migration wrote is
// then read back the way the running app reads it.
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'session-metadata-migration-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  handle = await createTestDatabase()
})

afterEach(async () => {
  await handle.close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const workspaceOf = (slug: string) => path.join(dataDir, 'agents', slug, 'workspace')
const metadataFile = (slug: string) => path.join(workspaceOf(slug), 'session-metadata.json')

async function addAgent(slug: string, metadata?: unknown, runtime = 'local'): Promise<void> {
  await handle.db.insert(agents).values({ slug, name: slug, createdAt: new Date(), runtime, workspaceHandle: null }).run()
  fs.mkdirSync(workspaceOf(slug), { recursive: true })
  // What every agent's workspace holds: an empty one reads as not mounted.
  fs.writeFileSync(path.join(workspaceOf(slug), 'AGENTS.md'), '# Agent\n')
  if (metadata !== undefined) {
    fs.writeFileSync(metadataFile(slug), typeof metadata === 'string' ? metadata : JSON.stringify(metadata, null, 2))
  }
}

function addTranscript(slug: string, sessionId: string, activityAt: string): void {
  const dir = path.join(workspaceOf(slug), '.claude', 'projects', '-workspace')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n')
  fs.utimesSync(path.join(dir, `${sessionId}.jsonl`), new Date(activityAt), new Date(activityAt))
}

const rows = async () =>
  (await handle.db.select().from(agentSessions).all())
    .map((row) => ({ ...row, metadata: row.metadata === null ? null : JSON.parse(row.metadata) }))
    .sort((a, b) => `${a.agentSlug}/${a.sessionId}`.localeCompare(`${b.agentSlug}/${b.sessionId}`))

describe('import-session-metadata', () => {
  it('takes every local agent\'s file into its index and removes the file', async () => {
    await addAgent('shop-reports', {
      'user-chat': { name: 'User chat', createdAt: '2026-10-20T00:00:00.000Z', starred: true },
      'scheduled-run': { name: 'Slow orders', createdAt: '2026-10-01T00:00:00.000Z', isScheduledExecution: true, scheduledTaskId: 'task-1', automationStatus: 'succeeded' },
    })
    await addAgent('inbox', { 'user-chat': { name: 'Same id, other agent', createdAt: '2026-10-21T00:00:00.000Z' } })
    await addAgent('never-ran')

    expect(await importSessionMetadata(handle.db)).toEqual([])

    expect(await rows()).toEqual([
      { agentSlug: 'inbox', sessionId: 'user-chat', metadata: { name: 'Same id, other agent', createdAt: '2026-10-21T00:00:00.000Z' }, transcriptMtimeMs: null, transcriptBirthtimeMs: null, transcriptSize: null },
      { agentSlug: 'shop-reports', sessionId: 'scheduled-run', metadata: { name: 'Slow orders', createdAt: '2026-10-01T00:00:00.000Z', isScheduledExecution: true, scheduledTaskId: 'task-1', automationStatus: 'succeeded' }, transcriptMtimeMs: null, transcriptBirthtimeMs: null, transcriptSize: null },
      { agentSlug: 'shop-reports', sessionId: 'user-chat', metadata: { name: 'User chat', createdAt: '2026-10-20T00:00:00.000Z', starred: true }, transcriptMtimeMs: null, transcriptBirthtimeMs: null, transcriptSize: null },
    ])
    expect(fs.existsSync(metadataFile('shop-reports'))).toBe(false)
    expect(fs.existsSync(metadataFile('inbox'))).toBe(false)
    expect(fs.readdirSync(workspaceOf('never-ran'))).toEqual(['AGENTS.md'])
  })

  it('stats no transcript: the first listing does that, and then names every session', async () => {
    await addAgent('shop-reports', {
      named: { name: 'Named session', createdAt: '2026-10-20T00:00:00.000Z' },
      'transcript-gone': { name: 'Deleted long ago', createdAt: '2026-10-01T00:00:00.000Z' },
    })
    addTranscript('shop-reports', 'named', '2026-10-22T00:00:00.000Z')
    addTranscript('shop-reports', 'never-registered', '2026-10-23T00:00:00.000Z')
    const stat = vi.spyOn(fs.promises, 'stat')

    await importSessionMetadata(handle.db)

    expect(stat.mock.calls.filter(([file]) => String(file).endsWith('.jsonl'))).toEqual([])
    stat.mockRestore()

    const { listSessions } = await import('@shared/lib/services/session-service')
    const { createLocalSessionStore } = await import('@shared/lib/agent-actor/local-session-store')
    const sessions = await listSessions(createLocalSessionStore('shop-reports'))
    expect(sessions.map(({ id, name, lastActivityAt }) => ({ id, name, lastActivityAt }))).toEqual([
      { id: 'never-registered', name: 'New Session', lastActivityAt: new Date('2026-10-23T00:00:00.000Z') },
      { id: 'named', name: 'Named session', lastActivityAt: new Date('2026-10-22T00:00:00.000Z') },
    ])
  })

  it('changes nothing when it runs again over what an interrupted run left', async () => {
    await addAgent('shop-reports', { 'user-chat': { name: 'User chat', createdAt: '2026-10-20T00:00:00.000Z' } })
    const file = fs.readFileSync(metadataFile('shop-reports'), 'utf-8')
    await importSessionMetadata(handle.db)
    // The run wrote the rows, the app renamed the session, and the file is
    // back as if the run had died before removing it.
    const { createLocalSessionStore } = await import('@shared/lib/agent-actor/local-session-store')
    const { updateSessionName, registerSession } = await import('@shared/lib/services/session-service')
    await updateSessionName(createLocalSessionStore('shop-reports'), 'user-chat', 'Renamed since')
    await registerSession(createLocalSessionStore('shop-reports'), 'created-since', 'Created since')
    fs.writeFileSync(metadataFile('shop-reports'), file)

    await importSessionMetadata(handle.db)

    expect((await rows()).map(({ sessionId, metadata }) => [sessionId, metadata.name])).toEqual([
      ['created-since', 'Created since'],
      ['user-chat', 'Renamed since'],
    ])
    expect(fs.existsSync(metadataFile('shop-reports'))).toBe(false)
  })

  it('sets a file it cannot parse aside, takes nothing from it, and carries on with the other agents', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await addAgent('corrupt', '{ "user-chat": { ')
    await addAgent('wrong-shape', { 'user-chat': 'not an object' })
    await addAgent('fine', { run: { name: 'Run', createdAt: '2026-10-01T00:00:00.000Z' } })

    expect(await importSessionMetadata(handle.db)).toEqual([])

    expect((await rows()).map((row) => `${row.agentSlug}/${row.sessionId}`)).toEqual(['fine/run'])
    for (const [slug, content] of [['corrupt', '{ "user-chat": { '], ['wrong-shape', JSON.stringify({ 'user-chat': 'not an object' }, null, 2)]]) {
      const left = fs.readdirSync(workspaceOf(slug)).filter((name) => name !== 'AGENTS.md')
      expect(left).toEqual([expect.stringMatching(/^session-metadata\.corrupt-\d+\.json$/)])
      expect(fs.readFileSync(path.join(workspaceOf(slug), left[0]), 'utf-8')).toBe(content)
    }
  })

  it('takes every entry that fits from a file with one that does not, and sets the file aside', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = {
      good: { name: 'Good', starred: true, createdAt: '2026-10-01T00:00:00.000Z' },
      'hand-edited': { name: 42 },
      'not-an-entry': 'text',
      'also-good': { name: 'Also good' },
    }
    await addAgent('edited', file)

    expect(await importSessionMetadata(handle.db)).toEqual([])

    expect((await rows()).map(({ sessionId, metadata }) => [sessionId, metadata.name])).toEqual([['also-good', 'Also good'], ['good', 'Good']])
    const left = fs.readdirSync(workspaceOf('edited')).filter((name) => name !== 'AGENTS.md')
    expect(left).toEqual([expect.stringMatching(/^session-metadata\.corrupt-\d+\.json$/)])
    expect(JSON.parse(fs.readFileSync(path.join(workspaceOf('edited'), left[0]), 'utf-8'))).toEqual(file)
  })

  it('reports an agent whose file cannot be read, leaves the file, and carries on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await addAgent('unreadable')
    // A directory where the file should be.
    fs.mkdirSync(metadataFile('unreadable'))
    await addAgent('fine', { run: { name: 'Run', createdAt: '2026-10-01T00:00:00.000Z' } })

    expect(await importSessionMetadata(handle.db)).toEqual(['unreadable'])

    expect((await rows()).map((row) => `${row.agentSlug}/${row.sessionId}`)).toEqual(['fine/run'])
    expect(fs.statSync(metadataFile('unreadable')).isDirectory()).toBe(true)
  })

  it('drops what an older build left in an entry and skips ids that cannot name a session', async () => {
    const commands = [{ name: 'deploy', description: 'Ship it', argumentHint: '' }]
    await addAgent('shop-reports', {
      'user-chat': { name: 'User chat', createdAt: '2026-10-20T00:00:00.000Z', slashCommands: commands, lastUsage: { inputTokens: 10, outputTokens: 5 } },
      '../escape': { name: 'Not a session id' },
    })

    await importSessionMetadata(handle.db)

    expect((await rows()).map(({ sessionId, metadata }) => [sessionId, metadata])).toEqual([
      ['user-chat', { name: 'User chat', createdAt: '2026-10-20T00:00:00.000Z', lastUsage: { totalTokens: 15, contextWindow: 0 } }],
    ])
  })

  it('leaves an agent placed elsewhere alone', async () => {
    await addAgent('remote', { run: { name: 'Run' } }, 'elsewhere')

    await importSessionMetadata(handle.db)

    expect(await rows()).toEqual([])
    expect(fs.existsSync(metadataFile('remote'))).toBe(true)
  })

  it('is not recorded while an agent\'s file could not be taken in, and takes it in on a later boot', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await addAgent('fine', { run: { name: 'Run' } })
    await addAgent('unreadable')
    fs.mkdirSync(metadataFile('unreadable'))

    expect(await runDataMigrations(handle.db, [importSessionMetadataMigration])).toEqual([])
    expect((await rows()).map((row) => `${row.agentSlug}/${row.sessionId}`)).toEqual(['fine/run'])

    // Readable by the next boot.
    fs.rmdirSync(metadataFile('unreadable'))
    fs.writeFileSync(metadataFile('unreadable'), JSON.stringify({ late: { name: 'Late' } }))
    expect(await runDataMigrations(handle.db, [importSessionMetadataMigration])).toEqual([10])
    expect((await rows()).map((row) => `${row.agentSlug}/${row.sessionId}`)).toEqual(['fine/run', 'unreadable/late'])
    expect(await runDataMigrations(handle.db, [importSessionMetadataMigration])).toEqual([])
  })

  it('waits for an agent whose workspace is not there: its volume may be mounted by the next boot', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await addAgent('unmounted', { chat: { name: 'Chat' } })
    const away = `${workspaceOf('unmounted')}.away`
    fs.renameSync(workspaceOf('unmounted'), away)

    expect(await importSessionMetadata(handle.db)).toEqual(['unmounted'])
    expect(await runDataMigrations(handle.db, [importSessionMetadataMigration])).toEqual([])

    fs.renameSync(away, workspaceOf('unmounted'))
    expect(await runDataMigrations(handle.db, [importSessionMetadataMigration])).toEqual([10])
    expect((await rows()).map(({ sessionId, metadata }) => [sessionId, metadata.name])).toEqual([['chat', 'Chat']])
    expect(fs.existsSync(metadataFile('unmounted'))).toBe(false)
  })

  it('runs once through the ledger', async () => {
    await addAgent('shop-reports', { run: { name: 'Run', createdAt: '2026-10-01T00:00:00.000Z' } })

    expect(await runDataMigrations(handle.db, [importSessionMetadataMigration])).toEqual([10])
    expect(await runDataMigrations(handle.db, [importSessionMetadataMigration])).toEqual([])
    expect(await rows()).toHaveLength(1)
  })
})
