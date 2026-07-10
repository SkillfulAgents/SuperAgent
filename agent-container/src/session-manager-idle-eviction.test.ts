import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockReleaseBrowserLock = vi.fn(() => false)
vi.mock('./browser-state', () => ({
  releaseBrowserLock: (...args: unknown[]) => mockReleaseBrowserLock(...(args as [])),
}))

const persistedSessions = new Map<string, Record<string, unknown>>()
vi.mock('./session-persistence', () => ({
  SessionPersistence: class {
    saveSession(meta: { sessionId: string } & Record<string, unknown>) {
      persistedSessions.set(meta.sessionId, meta)
    }
    getSession(id: string) { return persistedSessions.get(id) ?? null }
    deleteSession() {}
    updateLastActivity() {}
    updateEffort() {}
    updateModel() {}
    updateMetadata(id: string, metadata: Record<string, unknown> | undefined) {
      const existing = persistedSessions.get(id)
      if (existing) persistedSessions.set(id, { ...existing, metadata })
    }
  },
}))

// Minimal stand-in for ClaudeCodeProcess: an EventEmitter whose sendMessage
// emits the init handshake createSession waits on.
class MockClaudeProcess extends EventEmitter {
  running = false
  stopCalls = 0
  disposeCalls = 0
  sendMessageCalls = 0
  sessionId: string

  constructor(options: { sessionId: string }) {
    super()
    this.sessionId = options.sessionId
  }

  async start(): Promise<void> {
    if (nextStartDelayMs > 0) {
      const delay = nextStartDelayMs
      await new Promise((r) => setTimeout(r, delay))
    }
    if (nextStartFailure) {
      const err = nextStartFailure
      nextStartFailure = null
      throw err
    }
    this.running = true
  }

  async sendMessage(): Promise<void> {
    this.sendMessageCalls++
    if (nextInitFailure) {
      const err = nextInitFailure
      nextInitFailure = null
      this.emit('error', err)
      return
    }
    this.running = true
    this.emit('claude-session-id', this.sessionId)
    this.emit('init-complete')
  }

  async stop(): Promise<void> {
    this.stopCalls++
    this.running = false
  }

  async dispose(): Promise<void> {
    this.disposeCalls++
    await this.stop()
  }

  isRunning(): boolean {
    return this.running
  }

  get slashCommands() {
    return []
  }
}

const spawnedProcesses: MockClaudeProcess[] = []
// One-shot failure/latency injection for the next spawned process.
let nextInitFailure: Error | null = null
let nextStartFailure: Error | null = null
let nextStartDelayMs = 0
vi.mock('./claude-code', () => ({
  ClaudeCodeProcess: class {
    constructor(options: { sessionId: string }) {
      const proc = new MockClaudeProcess(options)
      spawnedProcesses.push(proc)
      return proc
    }
  },
}))

import { SessionManager } from './session-manager'

const IDLE_MS = 10

function emitIdle(proc: MockClaudeProcess) {
  proc.emit('message', { type: 'system', subtype: 'session_state_changed', state: 'idle' })
}

// Settled turn: result then idle (matches CLI order; bare idle is ignored).
function emitSettled(proc: MockClaudeProcess) {
  proc.emit('message', { type: 'result', subtype: 'success' })
  emitIdle(proc)
}

async function pastThreshold() {
  await new Promise((r) => setTimeout(r, IDLE_MS + 10))
}

describe('SessionManager idle eviction', () => {
  let manager: SessionManager
  let workDir: string

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-test-'))
    spawnedProcesses.length = 0
    persistedSessions.clear()
    mockReleaseBrowserLock.mockClear()
    nextInitFailure = null
    nextStartFailure = null
    nextStartDelayMs = 0
    // Interactive waits IDLE_MS; automated (cron/webhook) evicts immediately when idle.
    manager = new SessionManager(workDir, {
      idleEvictionMs: IDLE_MS,
      automatedIdleEvictionMs: 0,
    })
  })

  afterEach(async () => {
    await manager.stopAll()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  async function createIdleSession(options?: {
    metadata?: Record<string, unknown>
  }): Promise<{ id: string; proc: MockClaudeProcess }> {
    const session = await manager.createSession({
      initialMessage: 'hi',
      metadata: options?.metadata,
    })
    const proc = spawnedProcesses[spawnedProcesses.length - 1]
    emitSettled(proc)
    return { id: session.id, proc }
  }

  it('stops the process of a session idle past the threshold and keeps the session entry', async () => {
    const { id, proc } = await createIdleSession()
    await pastThreshold()

    await manager.evictIdleSessions()

    expect(proc.stopCalls).toBe(1)
    expect(proc.isRunning()).toBe(false)
    // Entry survives: still resolvable without a resume-from-persistence.
    expect(manager.hasActiveSession(id)).toBe(true)
    expect(mockReleaseBrowserLock).toHaveBeenCalledWith(id)
  })

  it('does not evict a session that is still busy', async () => {
    const { proc } = await createIdleSession()
    proc.emit('message', { type: 'system', subtype: 'session_state_changed', state: 'running' })
    await pastThreshold()

    await manager.evictIdleSessions()

    expect(proc.stopCalls).toBe(0)
  })

  it('does not evict an interactive session before the idle threshold elapses', async () => {
    const { proc } = await createIdleSession()

    await manager.evictIdleSessions()

    expect(proc.stopCalls).toBe(0)
  })

  it('evicts an automated session as soon as it is idle (threshold 0)', async () => {
    const { id, proc } = await createIdleSession({ metadata: { isAutomated: true } })

    await manager.evictIdleSessions()

    expect(proc.stopCalls).toBe(1)
    expect(proc.isRunning()).toBe(false)
    expect(manager.hasActiveSession(id)).toBe(true)
  })

  it('ignores idle without a result for this turn (stale idle race)', async () => {
    const session = await manager.createSession({ initialMessage: 'hi' })
    const proc = spawnedProcesses[spawnedProcesses.length - 1]
    emitIdle(proc) // no preceding result
    await pastThreshold()

    await manager.evictIdleSessions()

    expect(proc.stopCalls).toBe(0)
    expect(manager.hasActiveSession(session.id)).toBe(true)
  })

  it('does not evict while a background task is running, evicts after it settles', async () => {
    const { proc } = await createIdleSession()
    proc.emit('message', { type: 'system', subtype: 'task_started', task_id: 'bg-1' })
    emitSettled(proc) // SDK fires idle at turn-end while background work runs
    await pastThreshold()

    await manager.evictIdleSessions()
    expect(proc.stopCalls).toBe(0)

    proc.emit('message', { type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'completed' } })
    emitSettled(proc)
    await pastThreshold()

    await manager.evictIdleSessions()
    expect(proc.stopCalls).toBe(1)
  })

  it('clears a background task via task_notification too', async () => {
    const { proc } = await createIdleSession()
    proc.emit('message', { type: 'system', subtype: 'task_started', task_id: 'bg-2' })
    proc.emit('message', { type: 'system', subtype: 'task_notification', task_id: 'bg-2', status: 'completed' })
    emitSettled(proc)
    await pastThreshold()

    await manager.evictIdleSessions()
    expect(proc.stopCalls).toBe(1)
  })

  it('treats result as the idle signal when no state events were seen', async () => {
    const session = await manager.createSession({ initialMessage: 'hi' })
    const proc = spawnedProcesses[spawnedProcesses.length - 1]
    proc.emit('message', { type: 'result', subtype: 'success' })
    await pastThreshold()

    await manager.evictIdleSessions()

    expect(proc.stopCalls).toBe(1)
    expect(manager.hasActiveSession(session.id)).toBe(true)
  })

  it('sendMessage after eviction restarts the same process transparently', async () => {
    const { id, proc } = await createIdleSession()
    await pastThreshold()
    await manager.evictIdleSessions()
    expect(proc.isRunning()).toBe(false)

    await manager.sendMessage(id, 'follow-up')

    expect(proc.sendMessageCalls).toBe(2) // initial + follow-up
    expect(spawnedProcesses.length).toBe(1) // no new process object
  })

  it('evicts a session resumed via getSession that never receives a message', async () => {
    persistedSessions.set('cold-1', {
      sessionId: 'cold-1',
      claudeSessionId: 'cold-1',
      workingDirectory: workDir,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    })

    const session = await manager.getSession('cold-1')
    expect(session).not.toBeNull()
    const proc = spawnedProcesses[spawnedProcesses.length - 1]
    expect(proc.isRunning()).toBe(true)
    await pastThreshold()

    await manager.evictIdleSessions()

    expect(proc.stopCalls).toBe(1)
    expect(proc.isRunning()).toBe(false)
    expect(manager.hasActiveSession('cold-1')).toBe(true)
  })

  it('a resumed session that receives a message goes busy and is not evicted', async () => {
    persistedSessions.set('cold-2', {
      sessionId: 'cold-2',
      claudeSessionId: 'cold-2',
      workingDirectory: workDir,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    })

    await manager.sendMessage('cold-2', 'wake up')
    const proc = spawnedProcesses[spawnedProcesses.length - 1]
    await pastThreshold()

    await manager.evictIdleSessions()

    expect(proc.stopCalls).toBe(0)
    expect(proc.isRunning()).toBe(true)
  })

  it('a running state event after idle prevents eviction', async () => {
    const { proc } = await createIdleSession()
    proc.emit('message', { type: 'system', subtype: 'session_state_changed', state: 'running' })
    await pastThreshold()

    await manager.evictIdleSessions()

    expect(proc.stopCalls).toBe(0)
  })

  it('assistant traffic flips busy on a legacy stream without state events', async () => {
    const session = await manager.createSession({ initialMessage: 'hi' })
    const proc = spawnedProcesses[spawnedProcesses.length - 1]
    proc.emit('message', { type: 'result', subtype: 'success' }) // legacy settle
    proc.emit('message', { type: 'assistant', message: { content: [] } })
    await pastThreshold()

    await manager.evictIdleSessions()

    expect(proc.stopCalls).toBe(0)
    expect(manager.hasActiveSession(session.id)).toBe(true)
  })

  it('a shouldQuery:false append leaves the session evictable (no immortal busy)', async () => {
    const { id, proc } = await createIdleSession()

    // Transcript-only append (e.g. cross-agent chat notification): no turn
    // runs, no result will ever come — must not pin the session busy.
    await manager.sendMessage(id, 'fyi', undefined, { shouldQuery: false })
    // The SDK may echo the appended user message into the stream.
    proc.emit('message', { type: 'user', message: { role: 'user', content: [] } })
    await pastThreshold()

    await manager.evictIdleSessions()

    expect(proc.stopCalls).toBe(1)
    expect(manager.hasActiveSession(id)).toBe(true)
  })

  it("task_notification 'stopped' (TaskStop) clears the background hold", async () => {
    const { proc } = await createIdleSession()
    proc.emit('message', { type: 'system', subtype: 'task_started', task_id: 'bg-s' })
    emitSettled(proc) // result clears any wake grace from the drain below
    proc.emit('message', { type: 'system', subtype: 'task_notification', task_id: 'bg-s', status: 'stopped' })
    emitSettled(proc)
    await pastThreshold()

    await manager.evictIdleSessions()
    expect(proc.stopCalls).toBe(1)
  })

  it('a background_tasks_changed snapshot blocks and releases eviction', async () => {
    const { proc } = await createIdleSession()
    proc.emit('message', { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'snap-1' }] })
    await pastThreshold()

    await manager.evictIdleSessions()
    expect(proc.stopCalls).toBe(0)

    proc.emit('message', { type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    emitSettled(proc) // the wake turn after the drain
    await pastThreshold()

    await manager.evictIdleSessions()
    expect(proc.stopCalls).toBe(1)
  })

  it('holds through the completion-wake gap and evicts only after the wake turn settles', async () => {
    // Automated threshold 0 — the exact class exposed to the wake-gap race.
    const gapManager = new SessionManager(workDir, {
      idleEvictionMs: IDLE_MS,
      automatedIdleEvictionMs: 0,
      wakeGraceMs: 60_000,
    })
    try {
      await gapManager.createSession({ initialMessage: 'hi', metadata: { isAutomated: true } })
      const proc = spawnedProcesses[spawnedProcesses.length - 1]
      proc.emit('message', { type: 'system', subtype: 'task_started', task_id: 'bg-w' })
      emitSettled(proc) // premature idle: turn over, task still running

      // The last task drains while the session is idle — the wake's `running`
      // arrives 15-64ms later in real captures. A sweep in that gap must hold.
      proc.emit('message', { type: 'system', subtype: 'task_updated', task_id: 'bg-w', patch: { status: 'completed' } })
      await gapManager.evictIdleSessions()
      expect(proc.stopCalls).toBe(0)

      // Wake turn runs and settles — now the session is truly done.
      proc.emit('message', { type: 'system', subtype: 'session_state_changed', state: 'running' })
      emitSettled(proc)
      await gapManager.evictIdleSessions()
      expect(proc.stopCalls).toBe(1)
    } finally {
      await gapManager.stopAll()
    }
  })

  it('settles after the wake grace expires when no wake ever comes', async () => {
    const graceManager = new SessionManager(workDir, {
      idleEvictionMs: IDLE_MS,
      automatedIdleEvictionMs: 0,
      wakeGraceMs: 5,
    })
    try {
      await graceManager.createSession({ initialMessage: 'hi', metadata: { isAutomated: true } })
      const proc = spawnedProcesses[spawnedProcesses.length - 1]
      proc.emit('message', { type: 'system', subtype: 'task_started', task_id: 'bg-g' })
      emitSettled(proc)
      proc.emit('message', { type: 'system', subtype: 'task_updated', task_id: 'bg-g', patch: { status: 'completed' } })

      await graceManager.evictIdleSessions()
      expect(proc.stopCalls).toBe(0) // inside the grace

      await new Promise((r) => setTimeout(r, 20))
      await graceManager.evictIdleSessions()
      expect(proc.stopCalls).toBe(1) // grace expired, no pin
    } finally {
      await graceManager.stopAll()
    }
  })

  it('isAutomated survives persistence, so a bare-resumed automated session keeps its eviction class', async () => {
    const session = await manager.createSession({
      initialMessage: 'hi',
      metadata: { isAutomated: true },
    })
    const firstProc = spawnedProcesses[spawnedProcesses.length - 1]
    emitSettled(firstProc)
    await manager.stopAll()

    // Fresh manager = container restart. Interactive threshold is huge, so
    // only the restored isAutomated flag (threshold 0) can allow eviction.
    // Resume via a bare getSession — a human message would (correctly)
    // promote the session to interactive instead.
    const restarted = new SessionManager(workDir, {
      idleEvictionMs: 60 * 60_000,
      automatedIdleEvictionMs: 0,
    })
    try {
      const resumed = await restarted.getSession(session.id)
      expect(resumed?.metadata?.isAutomated).toBe(true)
      const proc = spawnedProcesses[spawnedProcesses.length - 1]

      await restarted.evictIdleSessions()
      expect(proc.stopCalls).toBe(1)
    } finally {
      await restarted.stopAll()
    }
  })

  it('a human message promotes an automated session to the interactive class', async () => {
    const promoManager = new SessionManager(workDir, {
      idleEvictionMs: 60 * 60_000, // interactive effectively off
      automatedIdleEvictionMs: 0,
    })
    try {
      const session = await promoManager.createSession({
        initialMessage: 'hi',
        metadata: { isAutomated: true },
      })
      const proc = spawnedProcesses[spawnedProcesses.length - 1]
      emitSettled(proc)

      await promoManager.evictIdleSessions()
      expect(proc.stopCalls).toBe(1) // automated: reaped at threshold 0

      // Human follow-up: resumes AND promotes — settled turns no longer
      // evict at threshold 0.
      await promoManager.sendMessage(session.id, 'hello, human here')
      emitSettled(proc)
      await promoManager.evictIdleSessions()
      expect(proc.stopCalls).toBe(1) // interactive 1h threshold now applies

      // Promotion is persisted: after a restart, a bare resume is still
      // interactive-class.
      expect(
        (persistedSessions.get(session.id)?.metadata as { isAutomated?: boolean })?.isAutomated
      ).toBe(false)
    } finally {
      await promoManager.stopAll()
    }
  })

  it('a send that bypasses SessionManager.sendMessage still marks the session busy (outbound-message event)', async () => {
    // The MCP-injection continuation calls ClaudeCodeProcess.sendMessage
    // directly; the process emits outbound-message and the manager listener
    // must flip the tracker busy, or a sweep landing before the CLI's
    // 'running' event kills the turn it just started.
    const { proc } = await createIdleSession({ metadata: { isAutomated: true } })

    proc.emit('outbound-message', { expectsResponse: true })
    await manager.evictIdleSessions()
    expect(proc.stopCalls).toBe(0)

    // The bypass turn then completes normally and the session settles again.
    emitSettled(proc)
    await manager.evictIdleSessions()
    expect(proc.stopCalls).toBe(1)
  })

  it('a failed createSession init handshake does not leak the started process', async () => {
    nextInitFailure = new Error('CLI crashed during boot')
    await expect(
      manager.createSession({ initialMessage: 'hi' })
    ).rejects.toThrow('CLI crashed during boot')

    // The process was started before the handshake failed; with no session
    // entry it is invisible to the reaper, so createSession itself must
    // stop it.
    const proc = spawnedProcesses[spawnedProcesses.length - 1]
    expect(proc.stopCalls).toBeGreaterThanOrEqual(1)
    expect(proc.isRunning()).toBe(false)
  })

  it('a failed resume does not leave a zombie session entry in the map', async () => {
    const { id } = await createIdleSession()
    await manager.stopAll()

    const restarted = new SessionManager(workDir, {
      idleEvictionMs: IDLE_MS,
      automatedIdleEvictionMs: 0,
    })
    try {
      nextStartFailure = new Error('resume boot failure')
      await expect(restarted.sendMessage(id, 'hello')).rejects.toThrow()
      // The failed resume must not leave a half-built entry that later
      // getSession/hasActiveSession calls report as a live session.
      expect(restarted.hasActiveSession(id)).toBe(false)

      // And the session is still resumable once the failure clears.
      await restarted.sendMessage(id, 'hello again')
      expect(restarted.hasActiveSession(id)).toBe(true)
    } finally {
      await restarted.stopAll()
    }
  })

  it('concurrent resumes of the same cold session spawn exactly one process', async () => {
    const { id } = await createIdleSession()
    await manager.stopAll()

    const restarted = new SessionManager(workDir, {
      idleEvictionMs: IDLE_MS,
      automatedIdleEvictionMs: 0,
    })
    try {
      nextStartDelayMs = 50 // hold both callers inside resumeSession's start()
      const before = spawnedProcesses.length
      await Promise.all([
        restarted.sendMessage(id, 'from the POST route'),
        restarted.getSession(id),
      ])
      nextStartDelayMs = 0

      // Without dedup, both callers miss the map and each spawns a process;
      // the loser of the sessions.set race leaks a live subprocess that no
      // map entry (and therefore no reaper sweep) can ever reach.
      expect(spawnedProcesses.length - before).toBe(1)
    } finally {
      await restarted.stopAll()
    }
  })

  it('a shouldQuery:false append does NOT promote an automated session', async () => {
    const promoManager = new SessionManager(workDir, {
      idleEvictionMs: 60 * 60_000,
      automatedIdleEvictionMs: 0,
    })
    try {
      const session = await promoManager.createSession({
        initialMessage: 'hi',
        metadata: { isAutomated: true },
      })
      const proc = spawnedProcesses[spawnedProcesses.length - 1]
      emitSettled(proc)

      // Cross-agent notification append: not a human, class unchanged.
      await promoManager.sendMessage(session.id, 'fyi', undefined, { shouldQuery: false })
      await promoManager.evictIdleSessions()
      expect(proc.stopCalls).toBe(1) // still automated: reaped at threshold 0
    } finally {
      await promoManager.stopAll()
    }
  })
})
