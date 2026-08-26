/**
 * listSessionsFromSummary's cost and cache-coherence properties — what makes
 * it safe to put on the per-poll request path. The contract it shares with
 * listSessions (visibility, ownership, ordering) lives in
 * session-service.listing.test.ts; this file pins what is specific to reading
 * from the summary cache.
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
  listSessionsFromSummary,
  readSessionMetadata,
  registerSession,
} from './session-service'
import {
  SESSION_SUMMARY_CACHE_TTL_MS,
  recordProvisionalSessionActivity,
  recordSessionActivity,
  revertSessionActivity,
} from './session-summary-cache'

describe('listSessionsFromSummary', () => {
  let testRoot: string
  let priorDataDir: string | undefined
  const agentSlug = 'summary-listing-agent'

  const workspaceDir = () => path.join(testRoot, 'agents', agentSlug, 'workspace')
  const sessionsDir = () => path.join(workspaceDir(), '.claude', 'projects', '-workspace')
  const transcriptPath = (sessionId: string) => path.join(sessionsDir(), `${sessionId}.jsonl`)

  beforeEach(async () => {
    testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'session-summary-listing-'))
    priorDataDir = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testRoot
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
    await registerSession(agentSlug, sessionId, sessionId)
    await fs.promises.writeFile(transcriptPath(sessionId), content)
    const timestamp = new Date(activityAt)
    await fs.promises.utimes(transcriptPath(sessionId), timestamp, timestamp)
  }

  const ids = (sessions: { id: string }[]) => sessions.map((s) => s.id)
  const transcriptStats = () => statProbe.paths.filter((file) => file.endsWith('.jsonl'))

  it('lists from a warm cache with one directory stat and no transcript stats', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(agentSlug)
    statProbe.paths.length = 0

    const sessions = await listSessionsFromSummary(agentSlug, {
      excludeAutomated: true,
      sortBy: 'last_activity_at',
    })

    expect(ids(sessions)).toEqual(['session-b', 'session-a'])
    expect(statProbe.paths).toEqual([sessionsDir()])
  })

  it('does not re-read metadata when the caller passes the map', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await getSessionSummary(agentSlug)
    const metadata = await readSessionMetadata(agentSlug)
    const readFile = vi.spyOn(fs.promises, 'readFile')

    const sessions = await listSessionsFromSummary(agentSlug, { metadata, excludeAutomated: true })

    expect(ids(sessions)).toEqual(['session-a'])
    expect(readFile).not.toHaveBeenCalled()
  })

  it('reorders on recorded activity without touching the filesystem', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(agentSlug)

    // The persister reports a write to the older session; no stat happens.
    recordSessionActivity(agentSlug, 'session-a', new Date('2026-01-03T00:00:00.000Z'))
    statProbe.paths.length = 0

    const sessions = await listSessionsFromSummary(agentSlug, { sortBy: 'last_activity_at' })

    expect(ids(sessions)).toEqual(['session-a', 'session-b'])
    expect(sessions[0]!.lastActivityAt).toEqual(new Date('2026-01-03T00:00:00.000Z'))
    expect(transcriptStats()).toEqual([])
  })

  it('keeps activity recorded while the cache is cold: the first build folds it in', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    // Nothing has read the summary yet (fresh process, or invalidated). The
    // send is recorded before the CLI touches the transcript.
    recordSessionActivity(agentSlug, 'session-a', new Date('2026-01-03T00:00:00.000Z'))

    const sessions = await listSessionsFromSummary(agentSlug, { sortBy: 'last_activity_at' })

    expect(ids(sessions)).toEqual(['session-a', 'session-b'])
    expect(sessions[0]!.lastActivityAt).toEqual(new Date('2026-01-03T00:00:00.000Z'))
  })

  it('keeps activity recorded against an expired cache across the TTL rebuild', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(agentSlug)
    statProbe.paths.length = 0

    // Real time moves past the TTL; the next read will rebuild from stats,
    // which do not carry the send yet.
    vi.useFakeTimers({ now: Date.now() + SESSION_SUMMARY_CACHE_TTL_MS + 1, toFake: ['Date'] })
    recordSessionActivity(agentSlug, 'session-a', Date.now())
    const recordedAt = Date.now()

    const sessions = await listSessionsFromSummary(agentSlug, { sortBy: 'last_activity_at' })

    expect(ids(sessions)).toEqual(['session-a', 'session-b'])
    expect(sessions[0]!.lastActivityAt.getTime()).toBe(recordedAt)
    // ...and the rebuild happened (every transcript stat'd), so this was not
    // just the stale value surviving.
    expect(transcriptStats().length).toBe(2)
  })

  it('a rolled-back provisional send restores the previous order', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(agentSlug)

    const mark = recordProvisionalSessionActivity(agentSlug, 'session-a', new Date('2026-01-03T00:00:00.000Z'))
    expect(ids(await listSessionsFromSummary(agentSlug, { sortBy: 'last_activity_at' })))
      .toEqual(['session-a', 'session-b'])

    revertSessionActivity(agentSlug, 'session-a', mark)

    const sessions = await listSessionsFromSummary(agentSlug, { sortBy: 'last_activity_at' })
    expect(ids(sessions)).toEqual(['session-b', 'session-a'])
    expect(sessions[1]!.lastActivityAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  it('a rollback never erases activity recorded after the mark', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(agentSlug)

    const mark = recordProvisionalSessionActivity(agentSlug, 'session-a', new Date('2026-01-03T00:00:00.000Z'))
    recordSessionActivity(agentSlug, 'session-a', new Date('2026-01-04T00:00:00.000Z'))
    revertSessionActivity(agentSlug, 'session-a', mark)

    const sessions = await listSessionsFromSummary(agentSlug, { sortBy: 'last_activity_at' })
    expect(ids(sessions)).toEqual(['session-a', 'session-b'])
    expect(sessions[0]!.lastActivityAt).toEqual(new Date('2026-01-04T00:00:00.000Z'))
  })

  it('a rollback of a send recorded against a cold cache forces a re-stat', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')

    const mark = recordProvisionalSessionActivity(agentSlug, 'session-a', new Date('2026-01-03T00:00:00.000Z'))
    expect(ids(await listSessionsFromSummary(agentSlug, { sortBy: 'last_activity_at' })))
      .toEqual(['session-a', 'session-b'])

    revertSessionActivity(agentSlug, 'session-a', mark)

    expect(ids(await listSessionsFromSummary(agentSlug, { sortBy: 'last_activity_at' })))
      .toEqual(['session-b', 'session-a'])
  })

  it('does not cache a transient stat failure as absence', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')

    // ESTALE on both the stat and its retry: the build fails and nothing is
    // cached — the alternative is a session hidden until the next TTL.
    statProbe.failures.set(transcriptPath('session-b'), { code: 'ESTALE', times: 2 })
    await expect(listSessionsFromSummary(agentSlug)).rejects.toMatchObject({ code: 'ESTALE' })

    // The filesystem recovers; the next read is complete.
    expect(ids(await listSessionsFromSummary(agentSlug, { sortBy: 'last_activity_at' })))
      .toEqual(['session-b', 'session-a'])
  })

  it('absorbs a single transient stat failure with one retry', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    statProbe.failures.set(transcriptPath('session-b'), { code: 'EIO', times: 1 })

    expect(ids(await listSessionsFromSummary(agentSlug, { sortBy: 'last_activity_at' })))
      .toEqual(['session-b', 'session-a'])
  })

  it('still drops a transcript deleted between readdir and stat', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    statProbe.failures.set(transcriptPath('session-b'), { code: 'ENOENT', times: 5 })

    // No throw, no retry storm; session-b is no longer backed by its
    // transcript and falls through to the metadata-only branch, ranked by
    // its registration time rather than the file's mtime.
    const sessions = await listSessionsFromSummary(agentSlug)
    expect(ids(sessions).sort()).toEqual(['session-a', 'session-b'])
    expect(sessions.find((s) => s.id === 'session-b')!.lastActivityAt)
      .not.toEqual(new Date('2026-01-02T00:00:00.000Z'))
    expect(statProbe.paths.filter((p) => p === transcriptPath('session-b'))).toHaveLength(1)
  })

  it('treats an unregistered empty transcript as a session once activity is recorded for it', async () => {
    // Cached as size 0 with no registration → an SDK artifact, hidden...
    await fs.promises.writeFile(transcriptPath('became-real'), '')
    await createSession('anchor', '2026-01-01T00:00:00.000Z')
    await getSessionSummary(agentSlug)
    expect(ids(await listSessionsFromSummary(agentSlug))).toEqual(['anchor'])

    // ...until the stream reports a write to it: bytes now exist, and
    // ownership was already established at build time.
    recordSessionActivity(agentSlug, 'became-real', new Date('2026-01-05T00:00:00.000Z'))

    expect(ids(await listSessionsFromSummary(agentSlug, { sortBy: 'last_activity_at' })))
      .toEqual(['became-real', 'anchor'])
  })

  it('picks up a transcript added after the cache was built', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await getSessionSummary(agentSlug)

    // registerSession claims ownership, which invalidates the summary; the
    // new file also bumps the directory mtime. Either alone would do.
    await createSession('session-b', '2026-01-02T00:00:00.000Z')

    const sessions = await listSessionsFromSummary(agentSlug, { sortBy: 'last_activity_at' })
    expect(ids(sessions)).toEqual(['session-b', 'session-a'])
  })

  it('drops a deleted session immediately', async () => {
    await createSession('session-a', '2026-01-01T00:00:00.000Z')
    await createSession('session-b', '2026-01-02T00:00:00.000Z')
    await getSessionSummary(agentSlug)

    await deleteSession(agentSlug, 'session-b')

    expect(ids(await listSessionsFromSummary(agentSlug))).toEqual(['session-a'])
  })

  it('includes registered sessions with no transcript and orders them by createdAt', async () => {
    await createSession('session-a', '2026-01-02T00:00:00.000Z')
    await registerSession(agentSlug, 'pending-newer', 'Pending')
    await getSessionSummary(agentSlug)
    const metadata = await readSessionMetadata(agentSlug)
    // registerSession stamps createdAt = now, newer than session-a's activity.
    expect(metadata['pending-newer']?.createdAt).toBeDefined()
    statProbe.paths.length = 0

    const sessions = await listSessionsFromSummary(agentSlug, {
      metadata,
      sortBy: 'last_activity_at',
    })

    expect(ids(sessions)).toEqual(['pending-newer', 'session-a'])
    expect(transcriptStats()).toEqual([])
  })
})
