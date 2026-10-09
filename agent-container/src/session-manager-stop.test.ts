/** A failed disposal must not interrupt fresh work on the next safe-stop attempt. */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('./browser-state', () => ({
  releaseBrowserLock: vi.fn(),
  renameBrowserSession: vi.fn(),
}))

const persistedSessions = new Map<string, unknown>()
vi.mock('./session-persistence', () => ({
  SessionPersistence: class {
    saveSession(data: { sessionId: string }) {
      persistedSessions.set(data.sessionId, data)
    }
    getSession(id: string) {
      return persistedSessions.get(id)
    }
    getAllSessions() {
      return Array.from(persistedSessions.values())
    }
    updateSession() {}
    updateLastActivity() {}
    deleteSession(id: string) {
      persistedSessions.delete(id)
    }
    addSessionCapabilityGrant() {}
    getSessionCapabilityGrants() {
      return []
    }
  },
}))

// Set to park every in-flight prewarm() until the test releases it.
let prewarmGate: Promise<void> | null = null

class MockClaudeProcess extends EventEmitter {
  static spawned: MockClaudeProcess[] = []
  prewarmCalls = 0
  disposeCalls = 0
  warm = false
  readonly options: Record<string, unknown>

  constructor(options: { sessionId: string } & Record<string, unknown>) {
    super()
    this.options = options
    MockClaudeProcess.spawned.push(this)
  }

  get sessionId(): string {
    return this.options.sessionId as string
  }

  async prewarm(): Promise<void> {
    if (prewarmGate) await prewarmGate
    this.prewarmCalls++
    this.warm = true
  }

  isPrewarmed(): boolean {
    return this.warm
  }

  async start(): Promise<void> {}

  async sendMessage(): Promise<void> {
    this.emit('claude-session-id', this.sessionId)
    this.emit('init-complete')
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {
    this.disposeCalls++
    this.warm = false
  }

  isRunning(): boolean {
    return true
  }

  get slashCommands() {
    return []
  }
}

// The factory is hoisted above the class declaration, so the reference has to
// happen at construction time rather than at factory-evaluation time.
vi.mock('./claude-code', () => ({
  ClaudeCodeProcess: class {
    constructor(options: { sessionId: string } & Record<string, unknown>) {
      return new MockClaudeProcess(options)
    }
  },
}))

import { SessionManager } from './session-manager'

const baseRequest = {
  initialMessage: 'hello',
  model: 'claude-opus-4-8',
  effort: 'high' as const,
}

import { Hono } from 'hono'
import { installVolumeStop } from './volume-stop'

describe('Safe stop after a failed writer cleanup', () => {
  it('refuses another stop before interrupting fresh sessions or dashboards', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-1340-'))
    MockClaudeProcess.spawned = []
    persistedSessions.clear()
    prewarmGate = null
    const manager = new SessionManager(workDir, { idleEvictionMs: -1, automatedIdleEvictionMs: -1 })
    const stopDashboards = vi.fn(async () => {})
    const app = new Hono()
    installVolumeStop(app, {
      hasVolumes: () => true,
      checkWriters: signal => manager.waitForStoppingWriters(signal),
      drain: async () => true,
      stopWriters: async signal => { await stopDashboards(); await manager.stopAll(false, signal) },
    })
    try {
      const first = await manager.createSession(baseRequest)
      const firstWriter = MockClaudeProcess.spawned.find(process => process.sessionId === first.id)!
      vi.spyOn(firstWriter, 'dispose').mockRejectedValue(new Error('disposal failed'))
      const firstStop = await app.request('/volumes/prepare-stop', { method: 'POST' })
      expect(firstStop.status).toBe(409)
      const next = await manager.createSession(baseRequest)
      const nextWriter = MockClaudeProcess.spawned.find(process => process.sessionId === next.id)!
      expect(nextWriter.disposeCalls).toBe(0)
      const secondStop = await app.request('/volumes/prepare-stop', { method: 'POST' })
      expect(secondStop.status).toBe(409)
      expect(await secondStop.json()).toEqual({ ready: false, workStopped: false })
      expect(nextWriter.disposeCalls).toBe(0)
      expect(stopDashboards).toHaveBeenCalledTimes(1)
    } finally {
      vi.restoreAllMocks()
      await manager.stopAll().catch(() => {})
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })
})
