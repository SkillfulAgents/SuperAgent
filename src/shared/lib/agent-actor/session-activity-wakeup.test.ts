/**
 * What recording a turn's activity costs a local agent's index in writes to
 * `agent_sessions`, on the real storage and the real task manager: about one
 * per interval instead of one per frame, with the last write of a turn
 * stored whoever is or is not reading. How the index decides is in
 * session-index.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { backgroundSettled } from '@shared/lib/background'
import { taskManager } from '@shared/lib/background-work'
import { closeBackgroundWork } from '@shared/lib/background-work/global'
import { perTestDatabase } from '@shared/lib/db/testing/per-test-database'
import { listSessions, registerSession } from '@shared/lib/services/session-service'
import { recordSessionActivity } from '@shared/lib/services/session-activity'
import { createDbSessionIndexStorage } from './db-session-index-storage'
import { createLocalSessionStore } from './local-session-store'
import { ACTIVITY_STORE_INTERVAL_MS, type SessionIndexStorage } from './session-index'
import type { SessionStore } from './session-store'

const database = perTestDatabase()
vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))

const agentSlug = 'streaming-agent'
/** Later than any transcript this suite writes, so recorded times are the newest. */
const TURN_STARTS_AT = new Date('2031-06-01T00:00:00.000Z').getTime()

describe('a local agent\'s recorded session activity', () => {
  let testRoot: string
  let priorDataDir: string | undefined
  let store: SessionStore
  /** Every write of activity the index made: the sessions of each. */
  let touches: string[][]

  const sessionsDir = () => path.join(testRoot, 'agents', agentSlug, 'workspace', '.claude', 'projects', '-workspace')
  /** What is in the table, read beside the index: a read through it would store first. */
  const storedActivity = async (sessionId: string) =>
    ((await createDbSessionIndexStorage(agentSlug).get(sessionId))?.transcript?.mtimeMs ?? 0) - TURN_STARTS_AT

  const counting = (slug: string): SessionIndexStorage => {
    const storage = createDbSessionIndexStorage(slug)
    return {
      ...storage,
      touch: (activity) => {
        touches.push([...activity.keys()])
        return storage.touch(activity)
      },
    }
  }

  async function createSession(sessionId: string, writtenAt: string): Promise<void> {
    await registerSession(store, sessionId, sessionId)
    const file = path.join(sessionsDir(), `${sessionId}.jsonl`)
    await fs.promises.writeFile(file, '{"type":"user","uuid":"u","message":{"role":"user","content":"hi"}}\n')
    await fs.promises.utimes(file, new Date(writtenAt), new Date(writtenAt))
  }

  /** The clock and the task manager's timers, and nothing the filesystem or the driver waits on. */
  const startTurn = () => vi.useFakeTimers({ now: TURN_STARTS_AT, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms)
  const frame = (...sessionIds: string[]) => {
    for (const sessionId of sessionIds) recordSessionActivity(store, sessionId, Date.now())
  }

  /**
   * A tool-heavy turn as the live session reports it: 20 rounds of one text
   * frame, five tool calls and their five results 50 ms apart, then 2.5 s of
   * model time; a closing answer and the result. 222 frames in 61 s.
   */
  async function toolHeavyTurn(...sessionIds: string[]): Promise<{ frames: number; lastFrameAt: number }> {
    let frames = 0
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 11; i++) {
        frame(...sessionIds)
        frames += 1
        await pass(50)
      }
      await pass(2500)
    }
    frame(...sessionIds)
    await pass(50)
    frame(...sessionIds)
    return { frames: frames + 2, lastFrameAt: Date.now() - TURN_STARTS_AT }
  }

  beforeEach(async () => {
    testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'session-activity-wakeup-'))
    priorDataDir = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testRoot
    touches = []
    store = createLocalSessionStore(agentSlug, { sessionIndexStorage: counting })
    await fs.promises.mkdir(sessionsDir(), { recursive: true })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await backgroundSettled()
    if (priorDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = priorDataDir
    await fs.promises.rm(testRoot, { recursive: true, force: true })
  })

  it('writes a 222-frame turn about once per interval, and stores its last frame with nobody reading', async () => {
    await createSession('s1', '2026-01-01T00:00:00.000Z')
    await store.index.entries()
    startTurn()

    const { frames, lastFrameAt } = await toolHeavyTurn('s1')
    await pass(ACTIVITY_STORE_INTERVAL_MS)

    expect(frames).toBe(222)
    // One write per frame before; now at most one per interval of the turn, and the one that closes it.
    expect(touches.length).toBeLessThanOrEqual(Math.ceil(lastFrameAt / ACTIVITY_STORE_INTERVAL_MS) + 1)
    expect(touches.length).toBeGreaterThan(0)
    expect(await storedActivity('s1')).toBe(lastFrameAt)

    // Nothing is left to store, however long it sits.
    const before = touches.length
    await pass(10 * ACTIVITY_STORE_INTERVAL_MS)
    expect(touches).toHaveLength(before)
  })

  it('stores nothing sooner than the interval, and everything by the end of it', async () => {
    await createSession('s1', '2026-01-01T00:00:00.000Z')
    await store.index.entries()
    startTurn()

    frame('s1')
    await pass(1000)
    frame('s1')
    await pass(ACTIVITY_STORE_INTERVAL_MS - 1001)
    expect(touches).toEqual([])

    await pass(1)
    expect(touches).toEqual([['s1']])
    expect(await storedActivity('s1')).toBe(1000)
  })

  it('stores the activity of several sessions of the agent in one write', async () => {
    await createSession('s1', '2026-01-01T00:00:00.000Z')
    await createSession('s2', '2026-01-02T00:00:00.000Z')
    await store.index.entries()
    startTurn()

    const { lastFrameAt } = await toolHeavyTurn('s1', 's2')
    await pass(ACTIVITY_STORE_INTERVAL_MS)

    expect(touches.length).toBeLessThanOrEqual(Math.ceil(lastFrameAt / ACTIVITY_STORE_INTERVAL_MS) + 1)
    expect(touches.every((sessionIds) => sessionIds.length === 2)).toBe(true)
    expect(await storedActivity('s1')).toBe(lastFrameAt)
    expect(await storedActivity('s2')).toBe(lastFrameAt)
  })

  it('lists a session by what was just recorded, before any wakeup', async () => {
    await createSession('older', '2026-01-01T00:00:00.000Z')
    await createSession('newer', '2026-01-02T00:00:00.000Z')
    const sorted = async () =>
      (await listSessions(store, { excludeAutomated: true, sortBy: 'last_activity_at' })).map((session) => session.id)
    expect(await sorted()).toEqual(['newer', 'older'])
    startTurn()

    frame('older')
    expect(touches).toEqual([])

    expect(await sorted()).toEqual(['older', 'newer'])
    // The read stored it, so the wakeup has nothing left to write.
    expect(touches).toEqual([['older']])
    await pass(2 * ACTIVITY_STORE_INTERVAL_MS)
    expect(touches).toEqual([['older']])
  })

  it('keeps the order of a turn that ended, for an index that starts over', async () => {
    await createSession('older', '2026-01-01T00:00:00.000Z')
    await createSession('newer', '2026-01-02T00:00:00.000Z')
    await store.index.entries()
    startTurn()

    await toolHeavyTurn('older')
    // What the live session does on a turn's result frame.
    await store.index.storeRecordedActivity()
    vi.useRealTimers()

    // The app restarts right then: a new actor's index has only the table.
    const restarted = createLocalSessionStore(agentSlug)
    const sessions = await listSessions(restarted, { excludeAutomated: true, sortBy: 'last_activity_at' })
    expect(sessions.map((session) => session.id)).toEqual(['older', 'newer'])
  })

  it('stores what is recorded when it is told to, after dispatch has stopped at shutdown', async () => {
    await createSession('s1', '2026-01-01T00:00:00.000Z')
    await store.index.entries()
    startTurn()
    await taskManager().stop()

    frame('s1')
    await pass(1000)
    frame('s1')
    await pass(3 * ACTIVITY_STORE_INTERVAL_MS)
    // No wakeup comes from a stopped manager.
    expect(touches).toEqual([])

    await store.index.storeRecordedActivity()
    expect(await storedActivity('s1')).toBe(1000)
  })

  it('stores each write as it is recorded where no task manager is installed', async () => {
    await createSession('s1', '2026-01-01T00:00:00.000Z')
    await store.index.entries()
    await closeBackgroundWork()

    recordSessionActivity(store, 's1', TURN_STARTS_AT + 5)
    await backgroundSettled()

    expect(touches).toEqual([['s1']])
    expect(await storedActivity('s1')).toBe(5)
  })

  it('keeps the wakeups of two stores of one agent apart', async () => {
    await createSession('s1', '2026-01-01T00:00:00.000Z')
    await createSession('s2', '2026-01-02T00:00:00.000Z')
    const second = createLocalSessionStore(agentSlug, { sessionIndexStorage: counting })
    await store.index.entries()
    await second.index.entries()
    startTurn()

    recordSessionActivity(store, 's1', TURN_STARTS_AT + 1)
    recordSessionActivity(second, 's2', TURN_STARTS_AT + 2)
    await pass(ACTIVITY_STORE_INTERVAL_MS)

    expect(await storedActivity('s1')).toBe(1)
    expect(await storedActivity('s2')).toBe(2)
  })
})
