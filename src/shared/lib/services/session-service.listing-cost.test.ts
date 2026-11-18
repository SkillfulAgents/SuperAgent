/**
 * listSessions's cost and coherence properties — what makes it safe to put
 * on the per-poll request path. Its visibility, ownership and ordering
 * contract lives in session-service.listing.test.ts; this file pins what
 * reading from the session index costs and how recorded activity shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import * as os from 'os'

const statProbe = vi.hoisted(() => ({
  paths: [] as string[],
  /** Inject `times` consecutive failures with `code` for stats of `path`. */
  failures: new Map<string, { code: string; times: number }>(),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: (async (...args: Parameters<typeof actual.promises.stat>) => {
        const target = String(args[0])
        statProbe.paths.push(target)
        const failure = statProbe.failures.get(target)
        if (failure && failure.times > 0) {
          failure.times -= 1
          throw Object.assign(new Error(`${failure.code}: injected`), { code: failure.code })
        }
        return actual.promises.stat(...args)
      }) as typeof actual.promises.stat,
    },
  }
})

import * as fs from 'fs'
import {
  deleteSession,
  getSessionSummary,
  listSessions,
  readSessionMetadata,
  registerSession,
} from './session-service'
import {
  recordProvisionalSessionActivity,
  recordSessionActivity,
  revertSessionActivity,
} from './session-activity'
import { createLocalSessionStore } from '@shared/lib/agent-actor/local-session-store'
import type { SessionStore } from '@shared/lib/agent-actor/session-store'
import { perTestDatabase } from '@shared/lib/db/testing/per-test-database'

const database = perTestDatabase()
vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))

describe('listSessions from the session index', () => {
  let testRoot: string
  let priorDataDir: string | undefined
  const agentSlug = 'summary-listing-agent'
  // What the index learned from the directory is the store's (the actor's,
  // in the app), so every read and write of a test goes through the one
  // store, as they would through the one actor handle.
  let store: SessionStore

  const workspaceDir = () => path.join(testRoot, 'agents', agentSlug, 'workspace')
  const sessionsDir = () => path.join(workspaceDir(), '.claude', 'projects', '-workspace')
  const transcriptPath = (sessionId: string) => path.join(sessionsDir(), `${sessionId}.jsonl`)

  beforeEach(async () => {
    testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'session-summary-listing-'))
    priorDataDir = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testRoot
    store = createLocalSessionStore(agentSlug)
    await fs.promises.mkdir(sessionsDir(), { recursive: true })
    statProbe.paths.length = 0
    statProbe.failures.clear()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (priorDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = priorDataDir
    await fs.promises.rm(testRoot, { recursive: true, force: true })
  })

  async function createSession(
    sessionId: string,
    activityAt: string,
    content = '{"type":"user","uuid":"u","message":{"role":"user","content":"hi"}}\n',
  ): Promise<void> {
    await registerSession(store, sessionId, sessionId)
    await fs.promises.writeFile(transcriptPath(sessionId), content)
    const timestamp = new Date(activityAt)
    await fs.promises.utimes(transcriptPath(sessionId), timestamp, timestamp)
  }

  const ids = (sessions: { id: string }[]) => sessions.map((s) => s.id)
  const transcriptStats = () => statProbe.paths.filter((file) => file.endsWith('.jsonl'))

  it('lists with one directory stat and no transcript stats once the directory was read', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(store)
    statProbe.paths.length = 0

    const sessions = await listSessions(store, {
      excludeAutomated: true,
      sortBy: 'last_activity_at',
    })

    expect(ids(sessions)).toEqual(['session-b', 'session-a'])
    expect(statProbe.paths).toEqual([sessionsDir()])
  })

  it('reads no file of the workspace: names come from the index', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await getSessionSummary(store)
    const readFile = vi.spyOn(fs.promises, 'readFile')
    const open = vi.spyOn(fs.promises, 'open')

    const sessions = await listSessions(store, { excludeAutomated: true })

    expect(sessions.map((s) => s.name)).toEqual(['session-a'])
    expect(readFile).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('reorders on recorded activity without touching the filesystem', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(store)

    // The live session reports a write to the older session; no stat happens.
    recordSessionActivity(store, 'session-a', new Date('2026-01-03T00:00:00.000Z'))
    statProbe.paths.length = 0

    const sessions = await listSessions(store, { sortBy: 'last_activity_at' })

    expect(ids(sessions)).toEqual(['session-a', 'session-b'])
    expect(sessions[0]!.lastActivityAt).toEqual(new Date('2026-01-03T00:00:00.000Z'))
    expect(transcriptStats()).toEqual([])
  })

  it('keeps activity recorded before the index has seen the transcript', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    // Nothing has listed the sessions yet, so the index has not seen the
    // transcripts. The send is recorded before the CLI touches the transcript.
    recordSessionActivity(store, 'session-a', new Date('2026-01-03T00:00:00.000Z'))

    const sessions = await listSessions(store, { sortBy: 'last_activity_at' })

    expect(ids(sessions)).toEqual(['session-a', 'session-b'])
    expect(sessions[0]!.lastActivityAt).toEqual(new Date('2026-01-03T00:00:00.000Z'))
  })

  it('never moves a session back when an older write is recorded after a newer one', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(store)

    recordSessionActivity(store, 'session-a', new Date('2026-01-05T00:00:00.000Z'))
    await listSessions(store)
    // A replayed frame, or a clock that disagrees.
    recordSessionActivity(store, 'session-a', new Date('2026-01-03T00:00:00.000Z'))

    const sessions = await listSessions(store, { sortBy: 'last_activity_at' })
    expect(sessions[0]).toMatchObject({ id: 'session-a', lastActivityAt: new Date('2026-01-05T00:00:00.000Z') })
  })

  it('a rolled-back provisional send restores the previous order', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(store)

    const mark = recordProvisionalSessionActivity(store, 'session-a', new Date('2026-01-03T00:00:00.000Z'))
    expect(ids(await listSessions(store, { sortBy: 'last_activity_at' })))
      .toEqual(['session-a', 'session-b'])

    revertSessionActivity(store, 'session-a', mark)

    const sessions = await listSessions(store, { sortBy: 'last_activity_at' })
    expect(ids(sessions)).toEqual(['session-b', 'session-a'])
    expect(sessions[1]!.lastActivityAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  it('a rollback never erases activity recorded after the mark', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(store)

    const mark = recordProvisionalSessionActivity(store, 'session-a', new Date('2026-01-03T00:00:00.000Z'))
    recordSessionActivity(store, 'session-a', new Date('2026-01-04T00:00:00.000Z'))
    revertSessionActivity(store, 'session-a', mark)

    const sessions = await listSessions(store, { sortBy: 'last_activity_at' })
    expect(ids(sessions)).toEqual(['session-a', 'session-b'])
    expect(sessions[0]!.lastActivityAt).toEqual(new Date('2026-01-04T00:00:00.000Z'))
  })

  it('rolls back a send recorded before the index has seen the transcript', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')

    const mark = recordProvisionalSessionActivity(store, 'session-a', new Date('2026-01-03T00:00:00.000Z'))
    expect(ids(await listSessions(store, { sortBy: 'last_activity_at' })))
      .toEqual(['session-a', 'session-b'])

    revertSessionActivity(store, 'session-a', mark)

    expect(ids(await listSessions(store, { sortBy: 'last_activity_at' })))
      .toEqual(['session-b', 'session-a'])
  })

  it('does not cache a transient stat failure as absence', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')

    // ESTALE on both the stat and its retry: the read fails and nothing is
    // recorded — the alternative is a session hidden until the directory
    // next changes.
    statProbe.failures.set(transcriptPath('session-b'), { code: 'ESTALE', times: 2 })
    await expect(listSessions(store)).rejects.toMatchObject({ code: 'ESTALE' })

    // The filesystem recovers; the next read is complete.
    expect(ids(await listSessions(store, { sortBy: 'last_activity_at' })))
      .toEqual(['session-b', 'session-a'])
  })

  it('absorbs a single transient stat failure with one retry', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    statProbe.failures.set(transcriptPath('session-b'), { code: 'EIO', times: 1 })

    expect(ids(await listSessions(store, { sortBy: 'last_activity_at' })))
      .toEqual(['session-b', 'session-a'])
  })

  it('still drops a transcript deleted between readdir and stat', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    statProbe.failures.set(transcriptPath('session-b'), { code: 'ENOENT', times: 5 })

    // No throw, no retry storm; session-b is no longer backed by its
    // transcript and falls through to the metadata-only branch, ranked by
    // its registration time rather than the file's mtime.
    const sessions = await listSessions(store)
    expect(ids(sessions).sort()).toEqual(['session-a', 'session-b'])
    expect(sessions.find((s) => s.id === 'session-b')!.lastActivityAt)
      .not.toEqual(new Date('2026-01-02T00:00:00.000Z'))
    expect(statProbe.paths.filter((p) => p === transcriptPath('session-b'))).toHaveLength(1)
  })

  it('treats an unregistered empty transcript as a session once activity is recorded for it', async () => {
    // Seen as size 0 with no registration → an SDK artifact, hidden...
    await fs.promises.writeFile(transcriptPath('became-real'), '')
    await createSession('anchor', '2026-01-01T00:00:00.000Z')
    await getSessionSummary(store)
    expect(ids(await listSessions(store))).toEqual(['anchor'])

    // ...until the stream reports a write to it: bytes now exist, and
    // the transcript was found in the agent's own directory.
    recordSessionActivity(store, 'became-real', new Date('2026-01-05T00:00:00.000Z'))

    expect(ids(await listSessions(store, { sortBy: 'last_activity_at' })))
      .toEqual(['became-real', 'anchor'])
  })

  it('picks up a transcript added after the directory was read', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await getSessionSummary(store)

    // The new file bumps the directory mtime, which is what the next read compares.
    await createSession('session-b', '2026-01-02T00:00:00.000Z')

    const sessions = await listSessions(store, { sortBy: 'last_activity_at' })
    expect(ids(sessions)).toEqual(['session-b', 'session-a'])
  })

  it('drops a deleted session immediately', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(store)

    await deleteSession(store, 'session-b')

    expect(ids(await listSessions(store))).toEqual(['session-a'])
  })

  it('includes registered sessions with no transcript and orders them by createdAt', async () => {
    await createSession('session-a', '2026-01-02T00:00:00.000Z')
    await registerSession(store, 'pending-newer', 'Pending')
    await getSessionSummary(store)
    const metadata = await readSessionMetadata(store)
    // registerSession stamps createdAt = now, newer than session-a's activity.
    expect(metadata['pending-newer']?.createdAt).toBeDefined()
    statProbe.paths.length = 0

    const sessions = await listSessions(store, { sortBy: 'last_activity_at' })

    expect(ids(sessions)).toEqual(['pending-newer', 'session-a'])
    expect(transcriptStats()).toEqual([])
  })
})
