/**
 * SessionManager.warmSession — the entry point of POST /sessions/:id/warm.
 * Resumes session data that is not in memory, restarts a cold process through
 * ClaudeCodeProcess.warm(), and leaves busy sessions alone. It restarts the
 * idle clock and grants finite eviction grace without marking the session
 * busy or promoting it, so the reaper can still evict it if no message follows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('./browser-state', () => ({ releaseBrowserLock: () => false }))

const persistedSessions = new Map<string, Record<string, unknown>>()
vi.mock('./session-persistence', () => ({
  SessionPersistence: class {
    saveSession(meta: { sessionId: string } & Record<string, unknown>) {
      persistedSessions.set(meta.sessionId, meta)
    }
    getSession(id: string) { return persistedSessions.get(id) ?? null }
    deleteSession(id: string) { persistedSessions.delete(id) }
    updateLastActivity() {}
    updateEffort() {}
    updateModel() {}
    updateMetadata(id: string, metadata: Record<string, unknown>) {
      const existing = persistedSessions.get(id)
      if (existing) persistedSessions.set(id, { ...existing, metadata })
    }
  },
}))

// Stand-in for ClaudeCodeProcess: running/cold state, plus warm() bookkeeping.
class MockClaudeProcess extends EventEmitter {
  running = false
  startCalls = 0
  stopCalls = 0
  warmCalls = 0
  sessionId: string
  requiresConnectionRuntime: boolean

  constructor(options: { sessionId: string; requiresConnectionRuntime?: boolean }) {
    super()
    this.sessionId = options.sessionId
    this.requiresConnectionRuntime = options.requiresConnectionRuntime ?? false
  }

  async start(): Promise<void> {
    this.startCalls++
    this.running = true
    this.emit('query-start')
  }

  async sendMessage(): Promise<void> {
    this.running = true
    this.emit('claude-session-id', this.sessionId)
    this.emit('init-complete')
  }

  async warm(): Promise<boolean> {
    this.warmCalls++
    if (this.running) return false
    this.running = true
    this.emit('query-start')
    return true
  }

  async stop(): Promise<void> {
    this.stopCalls++
    this.running = false
  }

  async dispose(): Promise<void> {
    await this.stop()
  }

  isRunning(): boolean {
    return this.running
  }

  get slashCommands() {
    return []
  }
}

const spawned: MockClaudeProcess[] = []
vi.mock('./claude-code', () => ({
  ClaudeCodeProcess: class {
    constructor(options: { sessionId: string; requiresConnectionRuntime?: boolean }) {
      const proc = new MockClaudeProcess(options)
      spawned.push(proc)
      return proc
    }
  },
}))

import { SessionManager } from './session-manager'

const IDLE_MS = 200

function emitSettled(proc: MockClaudeProcess) {
  proc.emit('message', { type: 'result', subtype: 'success' })
  proc.emit('message', { type: 'system', subtype: 'session_state_changed', state: 'idle' })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function persist(sessionId: string, extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString()
  persistedSessions.set(sessionId, {
    sessionId,
    claudeSessionId: sessionId,
    workingDirectory: '/workspace',
    createdAt: now,
    lastActivity: now,
    ...extra,
  })
}

describe('SessionManager.warmSession', () => {
  let manager: SessionManager
  let workDir: string

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-pre-resume-'))
    spawned.length = 0
    persistedSessions.clear()
    manager = new SessionManager(workDir, { prewarmEnabled: false, idleEvictionMs: IDLE_MS, automatedIdleEvictionMs: 0, warmGraceMs: IDLE_MS })
  })

  afterEach(async () => {
    await manager.stopAll()
    vi.useRealTimers()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  async function settledSession(): Promise<{ id: string; proc: MockClaudeProcess }> {
    const session = await manager.createSession({ initialMessage: 'hi' })
    const proc = spawned[spawned.length - 1]
    emitSettled(proc)
    return { id: session.id, proc }
  }

  async function evictedSession(): Promise<{ id: string; proc: MockClaudeProcess }> {
    const created = await settledSession()
    await sleep(IDLE_MS + 20)
    await manager.evictIdleSessions()
    expect(created.proc.isRunning()).toBe(false)
    return created
  }

  it('reports an unknown session without creating anything', async () => {
    expect(manager.hasSession('nope')).toBe(false)
    await expect(manager.warmSession('nope')).resolves.toBe('unknown')
    expect(spawned).toHaveLength(0)
  })

  it('restarts an evicted session once, leaves it idle, and lets the reaper evict it again', async () => {
    const { id, proc } = await evictedSession()
    expect(proc.stopCalls).toBe(1)

    await expect(manager.warmSession(id)).resolves.toBe('resumed')

    expect(proc.warmCalls).toBe(1)
    expect(proc.isRunning()).toBe(true)
    expect(manager.isTurnInFlight(id)).toBe(false)
    expect(spawned).toHaveLength(1) // same process object, no new session process

    // Fresh idle clock: not evicted right away...
    await manager.evictIdleSessions()
    expect(proc.stopCalls).toBe(1)
    // ...but nothing pins it: with no message, the next sweep past the threshold reclaims it.
    await sleep(IDLE_MS + 20)
    await manager.evictIdleSessions()
    expect(proc.stopCalls).toBe(2)
    expect(proc.isRunning()).toBe(false)
  })

  it('only restarts the idle clock of a live session', async () => {
    const { id, proc } = await settledSession()
    await sleep(IDLE_MS * 0.75)

    await expect(manager.warmSession(id)).resolves.toBe('running')
    expect(proc.warmCalls).toBe(0)

    // Past the threshold measured from the last turn, but not from the warm-up.
    await sleep(IDLE_MS * 0.5)
    await manager.evictIdleSessions()
    expect(proc.stopCalls).toBe(0)
    expect(manager.isTurnInFlight(id)).toBe(false)
  })

  it('leaves a busy session alone', async () => {
    const session = await manager.createSession({ initialMessage: 'long task' })
    const proc = spawned[spawned.length - 1]

    await expect(manager.warmSession(session.id)).resolves.toBe('busy')
    expect(proc.warmCalls).toBe(0)
  })

  it('waits for an eviction in flight, then restarts the process it stopped', async () => {
    const { id, proc } = await settledSession()
    let finishStop!: () => void
    vi.spyOn(proc, 'stop').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishStop = resolve })
      proc.running = false
    })
    await sleep(IDLE_MS + 20)
    const eviction = manager.evictIdleSessions()

    const warm = manager.warmSession(id)
    await sleep(20)
    expect(proc.warmCalls).toBe(0) // nothing touches the process while it is being stopped

    finishStop()
    await eviction
    await expect(warm).resolves.toBe('resumed')
    expect(proc.warmCalls).toBe(1)
    expect(proc.isRunning()).toBe(true)
  })

  it('resumes a persisted session that is not in memory', async () => {
    persist('from-disk')
    expect(manager.hasSession('from-disk')).toBe(true)

    await expect(manager.warmSession('from-disk')).resolves.toBe('resumed')

    expect(spawned).toHaveLength(1)
    expect(spawned[0].startCalls).toBe(1) // started by the resume itself
    expect(spawned[0].warmCalls).toBe(0)
    expect(manager.hasActiveSession('from-disk')).toBe(true)
  })

  it('starts a persisted session whose start waits for credentials through the pre-resume', async () => {
    persist('deferred', { llmProviderId: 'connection-1' })

    await expect(manager.warmSession('deferred')).resolves.toBe('resumed')

    expect(spawned).toHaveLength(1)
    expect(spawned[0].requiresConnectionRuntime).toBe(true)
    expect(spawned[0].startCalls).toBe(0)
    expect(spawned[0].warmCalls).toBe(1)
    expect(spawned[0].isRunning()).toBe(true)
  })

  it('skips a session deleted while its eviction was finishing', async () => {
    const { id, proc } = await settledSession()
    let finishStop!: () => void
    vi.spyOn(proc, 'stop').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishStop = resolve })
      proc.running = false
    })
    await sleep(IDLE_MS + 20)
    const eviction = manager.evictIdleSessions()
    const warm = manager.warmSession(id)
    await sleep(20)

    const deleted = manager.deleteSession(id)
    finishStop()
    await Promise.all([eviction, deleted])

    await expect(warm).resolves.toBe('skipped')
    expect(proc.warmCalls).toBe(0)
  })

  it('does not resurrect sessions once the manager is shutting down', async () => {
    persist('after-shutdown')
    await manager.stopAll()

    await expect(manager.warmSession('after-shutdown')).resolves.toBe('skipped')
    expect(spawned).toHaveLength(0)
  })

  describe('bounded eviction grace', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    })

    const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

    async function automatedSession() {
      const session = await manager.createSession({ initialMessage: 'scheduled task', metadata: { isAutomated: true } })
      const proc = spawned[spawned.length - 1]
      emitSettled(proc)
      return { id: session.id, proc }
    }

    it.each(['live', 'evicted', 'persisted', 'deferred'])('protects a %s automated session, then reclaims it without a message', async (state) => {
      let id: string
      if (state === 'persisted' || state === 'deferred') {
        id = `automated-${state}`
        persist(id, { metadata: { isAutomated: true }, ...(state === 'deferred' ? { llmProviderId: 'connection-1' } : {}) })
      } else {
        id = (await automatedSession()).id
        if (state === 'evicted') {
          await manager.evictIdleSessions()
          expect(spawned.at(-1)!.isRunning()).toBe(false)
        }
      }
      const before = structuredClone(persistedSessions.get(id))

      await expect(manager.warmSession(id)).resolves.toBe(state === 'live' ? 'running' : 'resumed')
      const proc = spawned.at(-1)!
      const stoppedBefore = proc.stopCalls
      expect(manager.isTurnInFlight(id)).toBe(false)
      expect(manager.getAllSessions().find((s) => s.id === id)?.metadata?.isAutomated).toBe(true)
      expect(persistedSessions.get(id)).toEqual(before)

      await manager.evictIdleSessions()
      advance(IDLE_MS - 1)
      await manager.evictIdleSessions()
      expect(proc.stopCalls).toBe(stoppedBefore)
      expect(proc.isRunning()).toBe(true)

      advance(1)
      await manager.evictIdleSessions()
      expect(proc.stopCalls).toBe(stoppedBefore + 1)
      expect(proc.isRunning()).toBe(false)
    })

    it('extends the grace only when another warm request arrives', async () => {
      const { id, proc } = await automatedSession()
      await manager.warmSession(id)
      advance(IDLE_MS - 1)
      await manager.warmSession(id)

      advance(IDLE_MS - 1)
      await manager.evictIdleSessions()
      expect(proc.isRunning()).toBe(true)
      expect(proc.warmCalls).toBe(0) // live requests extend the deadline without restarting

      advance(1)
      await manager.evictIdleSessions()
      expect(proc.isRunning()).toBe(false)
    })

    it('only promotes the automated session when the human actually sends', async () => {
      const { id, proc } = await automatedSession()
      await manager.evictIdleSessions()
      await manager.warmSession(id)
      advance(IDLE_MS / 2)
      await manager.sendMessage(id, 'human reply')
      expect(manager.isTurnInFlight(id)).toBe(true)
      expect(manager.getAllSessions().find((s) => s.id === id)?.metadata?.isAutomated).toBe(false)
      expect(persistedSessions.get(id)?.metadata).toEqual({ isAutomated: false })
      emitSettled(proc)

      advance(IDLE_MS / 2) // the speculative grace expires, but real activity is newer
      await manager.evictIdleSessions()
      expect(proc.isRunning()).toBe(true)
      advance(IDLE_MS / 2)
      await manager.evictIdleSessions()
      expect(proc.isRunning()).toBe(false)
    })

    it('does not grant grace to an automated session that is busy', async () => {
      const session = await manager.createSession({ initialMessage: 'scheduled task', metadata: { isAutomated: true } })
      const proc = spawned.at(-1)!
      await expect(manager.warmSession(session.id)).resolves.toBe('busy')
      emitSettled(proc)
      await manager.evictIdleSessions()
      expect(proc.isRunning()).toBe(false)
      expect(proc.warmCalls).toBe(0)
    })

    it('protects a cold automated process while warm is still completing', async () => {
      const { id, proc } = await automatedSession()
      await manager.evictIdleSessions()
      let finishWarm!: () => void
      vi.spyOn(proc, 'warm').mockImplementationOnce(async () => {
        proc.running = true
        await new Promise<void>((resolve) => { finishWarm = resolve })
        return true
      })
      const warm = manager.warmSession(id)
      await manager.evictIdleSessions()
      expect(proc.isRunning()).toBe(true)
      expect(manager.isTurnInFlight(id)).toBe(false)
      finishWarm()
      await expect(warm).resolves.toBe('resumed')
      advance(IDLE_MS)
      await manager.evictIdleSessions()
      expect(proc.isRunning()).toBe(false)
    })

    it('uses a finite two-minute grace by default, including a zero interactive threshold', async () => {
      await manager.stopAll()
      manager = new SessionManager(workDir, { prewarmEnabled: false, idleEvictionMs: 0, automatedIdleEvictionMs: 0 })
      const { id, proc } = await settledSession()
      await manager.evictIdleSessions()
      await manager.warmSession(id)

      advance(2 * 60_000 - 1)
      await manager.evictIdleSessions()
      expect(proc.isRunning()).toBe(true)
      advance(1)
      await manager.evictIdleSessions()
      expect(proc.isRunning()).toBe(false)
    })

    it('still honors disabled idle eviction after the grace expires', async () => {
      await manager.stopAll()
      manager = new SessionManager(workDir, { prewarmEnabled: false, idleEvictionMs: -1, automatedIdleEvictionMs: -1, warmGraceMs: IDLE_MS })
      const { id, proc } = await automatedSession()
      await manager.warmSession(id)
      advance(IDLE_MS * 10)
      await manager.evictIdleSessions()
      expect(proc.isRunning()).toBe(true)
    })
  })
})
