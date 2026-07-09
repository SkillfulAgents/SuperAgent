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
    saveSession() {}
    getSession(id: string) { return persistedSessions.get(id) ?? null }
    deleteSession() {}
    updateLastActivity() {}
    updateEffort() {}
    updateModel() {}
  },
}))

// Minimal stand-in for ClaudeCodeProcess: an EventEmitter whose sendMessage
// emits the init handshake createSession waits on.
class MockClaudeProcess extends EventEmitter {
  running = false
  stopCalls = 0
  sendMessageCalls = 0
  sessionId: string

  constructor(options: { sessionId: string }) {
    super()
    this.sessionId = options.sessionId
  }

  async start(): Promise<void> {
    this.running = true
  }

  async sendMessage(): Promise<void> {
    this.sendMessageCalls++
    this.running = true
    this.emit('claude-session-id', this.sessionId)
    this.emit('init-complete')
  }

  async stop(): Promise<void> {
    this.stopCalls++
    this.running = false
  }

  isRunning(): boolean {
    return this.running
  }

  get slashCommands() {
    return []
  }
}

const spawnedProcesses: MockClaudeProcess[] = []
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

  it('a new message after idle resets the busy state and prevents eviction', async () => {
    const { proc } = await createIdleSession()
    proc.emit('message', { type: 'assistant', message: { content: [] } })
    await pastThreshold()

    await manager.evictIdleSessions()

    expect(proc.stopCalls).toBe(0)
  })
})
