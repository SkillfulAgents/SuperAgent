/**
 * What a local agent's recorded session activity survives. Storing it is
 * delayed to save writes (session-activity-wakeup.test.ts pins how many), and
 * these are the two places a delay must not reach: a session's first write
 * after it sat idle, and a write recorded while the app is shutting down.
 * Either one left in memory leaves the session, after a restart, where it
 * was before the write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { backgroundSettled } from '@shared/lib/background'
import { taskManager } from '@shared/lib/background-work'
import { perTestDatabase } from '@shared/lib/db/testing/per-test-database'
import { listSessions, registerSession } from '@shared/lib/services/session-service'
import { recordSessionActivity } from '@shared/lib/services/session-activity'
import { createLocalSessionStore } from './local-session-store'
import type { SessionStore } from './session-store'

const database = perTestDatabase()
vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))

const agentSlug = 'durable-agent'
/** Later than any transcript this suite writes. */
const NOW = new Date('2031-06-01T00:00:00.000Z').getTime()

describe('a local agent\'s recorded session activity, after the process is gone', () => {
  let testRoot: string
  let priorDataDir: string | undefined
  let store: SessionStore

  const sessionsDir = () => path.join(testRoot, 'agents', agentSlug, 'workspace', '.claude', 'projects', '-workspace')

  async function createSession(sessionId: string, writtenAt: string): Promise<void> {
    await registerSession(store, sessionId, sessionId)
    const file = path.join(sessionsDir(), `${sessionId}.jsonl`)
    await fs.promises.writeFile(file, '{"type":"user","uuid":"u","message":{"role":"user","content":"hi"}}\n')
    await fs.promises.utimes(file, new Date(writtenAt), new Date(writtenAt))
  }

  /**
   * The sessions as the next process lists them: a new store, whose index
   * has only what was stored. Nothing is read through the old one, since a
   * read would store what it holds.
   */
  const afterRestart = async () => {
    vi.useRealTimers()
    const restarted = createLocalSessionStore(agentSlug)
    const sessions = await listSessions(restarted, { excludeAutomated: true, sortBy: 'last_activity_at' })
    return sessions.map((session) => [session.id, new Date(session.lastActivityAt).getTime() - NOW])
  }

  beforeEach(async () => {
    testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'session-activity-durability-'))
    priorDataDir = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testRoot
    store = createLocalSessionStore(agentSlug)
    await fs.promises.mkdir(sessionsDir(), { recursive: true })
    await createSession('months-ago', '2026-01-01T00:00:00.000Z')
    await createSession('last-week', '2026-05-25T00:00:00.000Z')
    await store.index.entries()
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await backgroundSettled()
    if (priorDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = priorDataDir
    await fs.promises.rm(testRoot, { recursive: true, force: true })
  })

  it('keeps a dormant session\'s first write when the process dies right after it', async () => {
    // A message reaches a session nobody touched for months, and the process
    // is killed before any timer runs and before anything reads.
    recordSessionActivity(store, 'months-ago', NOW)
    await backgroundSettled()

    expect(await afterRestart()).toEqual([
      ['months-ago', 0],
      ['last-week', expect.any(Number)],
    ])
  })

  it('keeps a session that wakes up while another of the agent\'s is streaming', async () => {
    // One session has been streaming for a while; its frames are a moment apart.
    for (let ms = 0; ms <= 12_000; ms += 500) {
      recordSessionActivity(store, 'last-week', Date.now())
      await vi.advanceTimersByTimeAsync(500)
    }
    // The dormant one gets its first write, and the process dies.
    const wokeAt = Date.now() - NOW
    recordSessionActivity(store, 'months-ago', Date.now())
    await backgroundSettled()

    const sessions = await afterRestart()
    expect(sessions[0]).toEqual(['months-ago', wokeAt])
    // The streaming one is behind by less than a moment's worth of frames, not by its whole turn.
    expect(sessions[1][0]).toBe('last-week')
    expect(wokeAt - (sessions[1][1] as number)).toBeLessThanOrEqual(5_000)
  })

  it('keeps a write recorded after dispatch has stopped for shutdown, the first to its session or not', async () => {
    // Shutdown stops dispatch first, then releases the agents. A transcript
    // append that was in flight lands after both, and nothing runs later to
    // store it: no wakeup, no read.
    recordSessionActivity(store, 'months-ago', NOW)
    await vi.advanceTimersByTimeAsync(1000)
    await taskManager().stop()
    // The release: `agentRegistry.evictAll()` has each index store what it holds.
    await (store.index as { storeRecordedActivity?: () => Promise<void> }).storeRecordedActivity?.()

    recordSessionActivity(store, 'months-ago', NOW + 1500)
    await vi.advanceTimersByTimeAsync(500)
    recordSessionActivity(store, 'last-week', NOW + 2000)
    recordSessionActivity(store, 'months-ago', NOW + 2100)
    await backgroundSettled()

    expect(await afterRestart()).toEqual([
      ['months-ago', 2100],
      ['last-week', 2000],
    ])
  })
})
