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

const statProbe = vi.hoisted(() => ({ paths: [] as string[] }))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: (async (...args: Parameters<typeof actual.promises.stat>) => {
        statProbe.paths.push(String(args[0]))
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
import { recordSessionActivity } from './session-summary-cache'

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
  })

  afterEach(async () => {
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
