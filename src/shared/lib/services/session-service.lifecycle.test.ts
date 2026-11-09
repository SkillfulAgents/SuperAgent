/**
 * A session's whole life against a real workspace directory and a real
 * database: created, written, renamed, starred, active, read after a
 * restart, forked, deleted. Each step checks every way the app asks about a
 * session (the list, the summary, the single read, the metadata, the
 * existence gates), because they must agree, and they are answered from two
 * places: the session index and the transcripts directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  deleteSession,
  deleteSessionsBatch,
  getSession,
  getSessionMetadata,
  getSessionSummary,
  getSessionsByScheduledTask,
  isSessionRegistered,
  listSessions,
  listSessionsByIds,
  readSessionMetadata,
  registerSession,
  sessionExists,
  sessionIsKnown,
  updateSessionMetadata,
  updateSessionName,
} from './session-service'
import { recordSessionActivity } from './session-activity'
import { createLocalSessionStore } from '@shared/lib/agent-actor/local-session-store'
import type { SessionStore } from '@shared/lib/agent-actor/session-store'
import { perTestDatabase } from '@shared/lib/db/testing/per-test-database'

const database = perTestDatabase()
vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))

const AGENT = 'lifecycle-agent'
let dataDir: string
let store: SessionStore

const workspaceDir = () => path.join(dataDir, 'agents', AGENT, 'workspace')
const sessionsDir = () => path.join(workspaceDir(), '.claude', 'projects', '-workspace')
const transcriptFile = (sessionId: string) => path.join(sessionsDir(), `${sessionId}.jsonl`)

/** What the container's CLI does on a session's first turn, at a known time. */
function writeTranscript(sessionId: string, at: string): void {
  fs.mkdirSync(sessionsDir(), { recursive: true })
  fs.writeFileSync(transcriptFile(sessionId), '{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}\n')
  fs.utimesSync(transcriptFile(sessionId), new Date(at), new Date(at))
}

/** Every answer the app can get about the agent's sessions, in one value. */
async function everything(from: SessionStore = store) {
  const sessions = await listSessions(from)
  const summary = await getSessionSummary(from)
  return {
    listed: sessions.map((s) => s.id),
    names: Object.fromEntries(sessions.map((s) => [s.id, s.name])),
    withTranscript: [...summary.sessionIds].sort(),
    lastActivityAt: summary.lastActivityAt,
    metadata: Object.keys(await readSessionMetadata(from)).sort(),
  }
}

beforeEach(() => {
  dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-lifecycle-')))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  fs.mkdirSync(workspaceDir(), { recursive: true })
  store = createLocalSessionStore(AGENT)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('a session, from creation to deletion', () => {
  it('is listed from its registration, before the agent has written anything', async () => {
    await registerSession(store, 'fresh', 'Plan the launch', { createdByUserId: 'user-1' })

    expect(await everything()).toEqual({
      listed: ['fresh'],
      names: { fresh: 'Plan the launch' },
      withTranscript: [],
      lastActivityAt: null,
      metadata: ['fresh'],
    })
    const single = await getSession(store, 'fresh')
    expect(single).toMatchObject({ id: 'fresh', agentSlug: AGENT, name: 'Plan the launch', origin: 'user' })
    expect(single!.lastActivityAt).toEqual(single!.createdAt)
    expect(await sessionIsKnown(store, 'fresh')).toBe(true)
    expect(await isSessionRegistered(store, 'fresh')).toBe(true)
    // No transcript yet: the gate that needs one says no.
    expect(await sessionExists(store, 'fresh')).toBe(false)
    expect((await getSessionMetadata(store, 'fresh'))?.createdByUserId).toBe('user-1')
  })

  it('gives a session registered without a name the default one', async () => {
    await registerSession(store, 'unnamed')

    expect((await listSessions(store))[0].name).toBe('New Session')
  })

  it('takes its activity from the transcript once the agent writes it, and keeps its registration date', async () => {
    await registerSession(store, 'fresh', 'Plan the launch')
    const registeredAt = (await getSession(store, 'fresh'))!.createdAt
    writeTranscript('fresh', '2030-01-01T00:00:00.000Z')

    const [listed] = await listSessions(store)
    expect(listed).toMatchObject({ id: 'fresh', name: 'Plan the launch', lastActivityAt: new Date('2030-01-01T00:00:00.000Z') })
    expect(listed.createdAt).toEqual(registeredAt)
    // The list, the single read and the by-id read say the same.
    expect(await getSession(store, 'fresh')).toEqual(listed)
    expect(await listSessionsByIds(store, ['fresh'])).toEqual([listed])
    expect(await sessionExists(store, 'fresh')).toBe(true)
    expect((await getSessionSummary(store)).lastActivityAt).toEqual(new Date('2030-01-01T00:00:00.000Z'))
  })

  it('lists a transcript nobody registered, and lets it be named afterwards', async () => {
    writeTranscript('from-the-cli', '2030-01-01T00:00:00.000Z')

    expect((await listSessions(store)).map((s) => [s.id, s.name])).toEqual([['from-the-cli', 'New Session']])
    expect(await isSessionRegistered(store, 'from-the-cli')).toBe(false)
    expect(await sessionIsKnown(store, 'from-the-cli')).toBe(true)

    await updateSessionName(store, 'from-the-cli', 'Named later')

    expect((await listSessions(store)).map((s) => [s.id, s.name, s.lastActivityAt])).toEqual([
      ['from-the-cli', 'Named later', new Date('2030-01-01T00:00:00.000Z')],
    ])
  })

  it('keeps a rename and a star through every later change', async () => {
    await registerSession(store, 's1', 'First name', { isScheduledExecution: true, scheduledTaskId: 'task-1', automationStatus: 'running' })
    writeTranscript('s1', '2030-01-01T00:00:00.000Z')
    await listSessions(store)

    await updateSessionName(store, 's1', 'Second name')
    await updateSessionMetadata(store, 's1', { starred: true })
    recordSessionActivity(store, 's1', new Date('2030-01-02T00:00:00.000Z'))
    await updateSessionMetadata(store, 's1', { lastUsage: { totalTokens: 1200, contextWindow: 200000 } })

    expect(await getSessionMetadata(store, 's1')).toEqual({
      name: 'Second name',
      starred: true,
      createdAt: expect.any(String),
      isScheduledExecution: true,
      scheduledTaskId: 'task-1',
      automationStatus: 'running',
      lastUsage: { totalTokens: 1200, contextWindow: 200000 },
    })
    expect(await getSession(store, 's1')).toMatchObject({ name: 'Second name', origin: 'scheduled' })
    expect((await getSessionsByScheduledTask(store, 'task-1')).map((s) => [s.id, s.name, s.lastActivityAt])).toEqual([
      ['s1', 'Second name', new Date('2030-01-02T00:00:00.000Z')],
    ])
  })

  it('moves to the top of the list on activity, without the transcript being read or statted', async () => {
    for (const [id, at] of [['older', '2030-01-01T00:00:00.000Z'], ['newer', '2030-01-02T00:00:00.000Z']]) {
      await registerSession(store, id, id)
      writeTranscript(id, at)
    }
    expect((await listSessions(store)).map((s) => s.id)).toEqual(['newer', 'older'])
    const stat = vi.spyOn(fs.promises, 'stat')

    recordSessionActivity(store, 'older', new Date('2030-01-03T00:00:00.000Z'))

    expect((await listSessions(store)).map((s) => [s.id, s.lastActivityAt])).toEqual([
      ['older', new Date('2030-01-03T00:00:00.000Z')],
      ['newer', new Date('2030-01-02T00:00:00.000Z')],
    ])
    expect(stat.mock.calls.filter(([file]) => String(file).endsWith('.jsonl'))).toEqual([])
  })

  it('reads the same after a restart as before it', async () => {
    await registerSession(store, 'written', 'Written')
    writeTranscript('written', '2030-01-01T00:00:00.000Z')
    await registerSession(store, 'pending', 'Pending')
    writeTranscript('unregistered', '2030-01-02T00:00:00.000Z')
    await updateSessionMetadata(store, 'written', { starred: true })
    await listSessions(store)
    recordSessionActivity(store, 'written', new Date('2030-01-05T00:00:00.000Z'))
    const before = { ...(await everything()), sessions: await listSessions(store) }

    const restarted = createLocalSessionStore(AGENT)

    expect({ ...(await everything(restarted)), sessions: await listSessions(restarted) }).toEqual(before)
  })

  it('forks into a second session that stands on its own', async () => {
    await registerSession(store, 'source', 'Source')
    writeTranscript('source', '2030-01-01T00:00:00.000Z')
    await listSessions(store)

    // What a fork does: the container copies the transcript, the host registers the copy.
    fs.copyFileSync(transcriptFile('source'), transcriptFile('fork'))
    fs.utimesSync(transcriptFile('fork'), new Date('2030-01-02T00:00:00.000Z'), new Date('2030-01-02T00:00:00.000Z'))
    await registerSession(store, 'fork', 'Source (fork)', { forkedFromSessionId: 'source' })

    expect((await listSessions(store)).map((s) => [s.id, s.name])).toEqual([['fork', 'Source (fork)'], ['source', 'Source']])

    await deleteSession(store, 'source')

    expect((await everything()).listed).toEqual(['fork'])
    expect((await getSessionMetadata(store, 'fork'))?.forkedFromSessionId).toBe('source')
  })

  it('is gone from every answer once deleted, and leaves the other sessions as they were', async () => {
    for (const [id, at] of [['kept', '2030-01-01T00:00:00.000Z'], ['doomed', '2030-01-02T00:00:00.000Z']]) {
      await registerSession(store, id, id)
      writeTranscript(id, at)
    }
    await updateSessionMetadata(store, 'kept', { starred: true })
    await listSessions(store)

    expect(await deleteSession(store, 'doomed')).toBe(true)

    expect(await everything()).toEqual({
      listed: ['kept'],
      names: { kept: 'kept' },
      withTranscript: ['kept'],
      lastActivityAt: new Date('2030-01-01T00:00:00.000Z'),
      metadata: ['kept'],
    })
    expect(fs.existsSync(transcriptFile('doomed'))).toBe(false)
    expect(await getSession(store, 'doomed')).toBeNull()
    expect(await getSessionMetadata(store, 'doomed')).toBeNull()
    expect(await sessionExists(store, 'doomed')).toBe(false)
    expect(await sessionIsKnown(store, 'doomed')).toBe(false)
    expect(await isSessionRegistered(store, 'doomed')).toBe(false)
    expect(await listSessionsByIds(store, ['doomed', 'kept'])).toHaveLength(1)
    expect((await getSessionMetadata(store, 'kept'))?.starred).toBe(true)
    // And it stays gone for a store that never knew it.
    expect((await everything(createLocalSessionStore(AGENT))).listed).toEqual(['kept'])
  })

  it('deletes a registration that never got a transcript', async () => {
    await registerSession(store, 'never-started', 'Never started')

    expect(await deleteSession(store, 'never-started')).toBe(true)

    expect((await everything()).listed).toEqual([])
    expect(await sessionIsKnown(store, 'never-started')).toBe(false)
  })

  it('keeps the entry when the transcript cannot be removed, so the session is not orphaned', async () => {
    await registerSession(store, 'stuck', 'Stuck')
    writeTranscript('stuck', '2030-01-01T00:00:00.000Z')
    await listSessions(store)
    vi.spyOn(store.files, 'delete').mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))

    await expect(deleteSession(store, 'stuck')).rejects.toThrow('EACCES')

    vi.restoreAllMocks()
    expect((await listSessions(store)).map((s) => [s.id, s.name])).toEqual([['stuck', 'Stuck']])
  })

  it('deletes a batch, keeping each session whose transcript could not be removed', async () => {
    for (const id of ['a', 'b', 'c', 'd']) {
      await registerSession(store, id, `Session ${id}`)
      writeTranscript(id, '2030-01-01T00:00:00.000Z')
    }
    await listSessions(store)
    const remove = store.files.delete.bind(store.files)
    vi.spyOn(store.files, 'delete').mockImplementation(async (file, options) => {
      if (file.endsWith('c.jsonl')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return remove(file, options)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect((await deleteSessionsBatch(store, ['a', 'c', 'd'])).sort()).toEqual(['a', 'd'])

    expect((await everything()).listed.sort()).toEqual(['b', 'c'])
    expect((await everything()).metadata).toEqual(['b', 'c'])
  })

  it('reuses a deleted session\'s id as a new session, with nothing of the old one', async () => {
    await registerSession(store, 'reused', 'Old life')
    writeTranscript('reused', '2030-01-01T00:00:00.000Z')
    await updateSessionMetadata(store, 'reused', { starred: true })
    await listSessions(store)
    recordSessionActivity(store, 'reused', new Date('2030-06-01T00:00:00.000Z'))
    await deleteSession(store, 'reused')

    await registerSession(store, 'reused', 'New life')
    writeTranscript('reused', '2030-02-01T00:00:00.000Z')

    expect((await listSessions(store)).map((s) => [s.id, s.name, s.lastActivityAt])).toEqual([
      ['reused', 'New life', new Date('2030-02-01T00:00:00.000Z')],
    ])
    expect((await getSessionMetadata(store, 'reused'))?.starred).toBeUndefined()
  })
})

describe('many sessions', () => {
  const COUNT = 1500

  it('lists, renames and deletes one among many without touching the others\' files', async () => {
    fs.mkdirSync(sessionsDir(), { recursive: true })
    for (let i = 0; i < COUNT; i++) {
      fs.writeFileSync(transcriptFile(`session-${i}`), '{}\n')
    }
    await store.index.fill(Array.from({ length: COUNT }, (_, i) => ({
      sessionId: `session-${i}`,
      meta: { name: `Session ${i}`, createdAt: '2030-01-01T00:00:00.000Z' },
      transcript: null,
    })))
    // The first listing sees every transcript, once.
    expect(await listSessions(store)).toHaveLength(COUNT)

    const stat = vi.spyOn(fs.promises, 'stat')
    const readdir = vi.spyOn(fs.promises, 'readdir')
    const writes = (['writeFile', 'rename', 'open', 'appendFile'] as const).map((method) => vi.spyOn(fs.promises, method))
    const updates = vi.spyOn(database.db, 'update')

    expect(await listSessions(store, { limit: 10 })).toHaveLength(10)
    await updateSessionName(store, 'session-700', 'Renamed')
    await updateSessionMetadata(store, 'session-700', { starred: true })
    expect(await getSessionMetadata(store, 'session-700')).toMatchObject({ name: 'Renamed', starred: true })

    // One stat of the directory for the listing; nothing else on the volume.
    expect(stat.mock.calls.map(([file]) => String(file))).toEqual([sessionsDir()])
    expect(readdir).not.toHaveBeenCalled()
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    // Each change is one row.
    expect(updates).toHaveBeenCalledTimes(2)

    await deleteSession(store, 'session-700')
    const after = await listSessions(store)
    expect(after).toHaveLength(COUNT - 1)
    expect(after.some((s) => s.id === 'session-700')).toBe(false)
  })
})
