/**
 * Pre-warmed subprocess pool.
 *
 * A parked, already-initialized CLI is what removes the multi-second wait from
 * session creation, so what matters here is that it is only ever handed to a
 * session whose query options would be identical, and that it can never be
 * left running with nothing pointing at it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
import { nextWarmProfileFromRequest } from './warm-profile'
import { agentCapabilityPoliciesSchema, speedLevelSchema } from './capability-policies'

const baseRequest = {
  initialMessage: 'hello',
  model: 'claude-opus-4-8',
  effort: 'high' as const,
}

describe('SessionManager pre-warm pool', () => {
  let manager: SessionManager
  let workDir: string

  // Built through the same normalization createSession uses, so a profile
  // handed to prewarm() directly keys identically to one derived from a
  // request — otherwise the claim would miss for reasons unrelated to the test.
  const profileFor = (model: string) =>
    nextWarmProfileFromRequest({
      ...baseRequest,
      model,
      workingDirectory: workDir,
      speed: speedLevelSchema.parse(undefined),
      capabilityPolicies: agentCapabilityPoliciesSchema.parse(undefined),
    })

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prewarm-test-'))
    MockClaudeProcess.spawned = []
    persistedSessions.clear()
    prewarmGate = null
    manager = new SessionManager(workDir, { idleEvictionMs: -1, automatedIdleEvictionMs: -1 })
  })

  afterEach(async () => {
    await manager.stopAll()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  // The whole point: the second session skips the boot the first one paid for.
  it('serves the next matching session from the pre-warmed process', async () => {
    await manager.createSession(baseRequest)
    const warmed = MockClaudeProcess.spawned.at(-1)!
    expect(warmed.prewarmCalls).toBe(1)

    const spawnedBefore = MockClaudeProcess.spawned.length
    const session = await manager.createSession(baseRequest)

    // The mock adopts its own temp id as the session id, so an id match proves
    // the warm process served this session — no second cold spawn.
    expect(session.id).toBe(warmed.sessionId)
    expect(warmed.disposeCalls).toBe(0)
    // Only the refill for the session AFTER this one was spawned.
    expect(MockClaudeProcess.spawned.length).toBe(spawnedBefore + 1)
  })

  // The composer only sends a model when the user explicitly picks one, so the
  // next session almost always arrives on the agent default. Warming for the
  // one-off pick instead would cost a wasted spawn AND a cold start.
  it('warms for the host-supplied default, not the model this session picked', async () => {
    const defaults = { model: 'claude-opus-4-8', effort: 'high' as const, speed: undefined }

    // A one-off pick: this session runs Sonnet, but the default is Opus.
    await manager.createSession({
      ...baseRequest,
      model: 'claude-sonnet-5',
      prewarmDefaults: defaults,
    })
    const warmed = MockClaudeProcess.spawned.at(-1)!
    expect(warmed.options.model).toBe('claude-opus-4-8')

    // Back to the default — it gets the warm process.
    const session = await manager.createSession({ ...baseRequest, prewarmDefaults: defaults })
    expect(session.id).toBe(warmed.sessionId)
    expect(warmed.disposeCalls).toBe(0)
  })

  // The boot warm-up uses the previous container's profile, so a default that
  // changed in between leaves a parked process nothing will ever claim.
  it('replaces a parked process when the wanted profile changes', async () => {
    await manager.createSession({ ...baseRequest, prewarmDefaults: { model: 'claude-opus-4-8' } })
    const stale = MockClaudeProcess.spawned.at(-1)!
    expect(stale.options.model).toBe('claude-opus-4-8')

    // Next session reports a different default (the agent's default changed).
    await manager.createSession({ ...baseRequest, prewarmDefaults: { model: 'claude-sonnet-5' } })

    expect(stale.disposeCalls).toBe(1)
    const replacement = MockClaudeProcess.spawned.at(-1)!
    expect(replacement.options.model).toBe('claude-sonnet-5')
    expect(replacement.prewarmCalls).toBe(1)
    // Spawning it is not enough — it has to survive to be claimed. Discarding
    // the stale process bumps the warm generation, so a replacement that
    // captured the generation too early rejects itself on the way in and the
    // next session pays a cold start anyway.
    expect(replacement.disposeCalls).toBe(0)
  })

  // Reachable when two session creations overlap and refill for different
  // profiles: the second refill finds the first one's process already parked.
  it('parks a replacement that was spawned while another profile was parked', async () => {
    await manager.prewarm(profileFor('claude-opus-4-8'))
    const stale = MockClaudeProcess.spawned.at(-1)!

    await manager.prewarm(profileFor('claude-sonnet-5'))
    const replacement = MockClaudeProcess.spawned.at(-1)!

    expect(stale.disposeCalls).toBe(1)
    expect(replacement.disposeCalls).toBe(0)
    // Claimable: the session it was warmed for gets it instead of starting cold.
    const session = await manager.createSession({
      ...baseRequest,
      prewarmDefaults: { model: 'claude-sonnet-5' },
      model: 'claude-sonnet-5',
    })
    expect(session.id).toBe(replacement.sessionId)
  })

  // Without a hint (cron, chat, cross-agent) the session's own shape is still
  // the best available guess.
  it('falls back to this session shape when the host sends no default', async () => {
    await manager.createSession({ ...baseRequest, model: 'claude-sonnet-5' })
    const warmed = MockClaudeProcess.spawned.at(-1)!

    expect(warmed.options.model).toBe('claude-sonnet-5')
  })

  // A warm process bakes in model/effort/prompt: handing it to a request that
  // asked for something else would silently run the wrong configuration.
  it('discards the pre-warmed process when the next session asks for different parameters', async () => {
    await manager.createSession(baseRequest)
    const warmed = MockClaudeProcess.spawned.at(-1)!

    const session = await manager.createSession({ ...baseRequest, model: 'claude-sonnet-5' })

    expect(session.id).not.toBe(warmed.sessionId)
    expect(warmed.disposeCalls).toBe(1)
  })

  // Absent/parsed-default values must not read as a different configuration.
  it('treats an omitted capability policy as the parsed default, not a mismatch', async () => {
    await manager.createSession(baseRequest)
    const warmed = MockClaudeProcess.spawned.at(-1)!

    const session = await manager.createSession({ ...baseRequest, capabilityPolicies: undefined })

    expect(session.id).toBe(warmed.sessionId)
  })

  // The first session after a container wake is the slow one, so the profile
  // has to survive the restart.
  it('pre-warms at boot from the profile persisted by the previous container', async () => {
    await manager.createSession(baseRequest)
    await manager.stopAll()

    MockClaudeProcess.spawned = []
    const restarted = new SessionManager(workDir, { idleEvictionMs: -1, automatedIdleEvictionMs: -1 })
    restarted.prewarmFromLastProfile()
    await vi.waitFor(() => expect(MockClaudeProcess.spawned.length).toBe(1))
    const warmed = MockClaudeProcess.spawned[0]
    await vi.waitFor(() => expect(warmed.prewarmCalls).toBe(1))

    const session = await restarted.createSession(baseRequest)
    expect(session.id).toBe(warmed.sessionId)
    await restarted.stopAll()
  })

  // The warm process captured the old REMOTE_MCPS when it spawned.
  it('discards the pre-warmed process when the environment changes', async () => {
    await manager.createSession(baseRequest)
    const warmed = MockClaudeProcess.spawned.at(-1)!

    await manager.discardPrewarmed('env var REMOTE_MCPS changed')

    expect(warmed.disposeCalls).toBe(1)
    const session = await manager.createSession(baseRequest)
    expect(session.id).not.toBe(warmed.sessionId)
  })

  // Nested profile fields decide what the process is BUILT with, so they have
  // to reach the key. A block-policy session claiming a process warmed under
  // allow would run with the capability tools baked into its query.
  it('does not share a warm process across differing capability policies', async () => {
    await manager.createSession({
      ...baseRequest,
      capabilityPolicies: { subagents: 'allow', workflows: 'allow' },
    })
    const warmed = MockClaudeProcess.spawned.at(-1)!

    const session = await manager.createSession({
      ...baseRequest,
      capabilityPolicies: { subagents: 'block', workflows: 'block' },
    })

    expect(session.id).not.toBe(warmed.sessionId)
    expect(warmed.disposeCalls).toBe(1)
  })

  it('does not share a warm process across differing custom env vars', async () => {
    await manager.createSession({ ...baseRequest, customEnvVars: { API_BASE: 'one' } })
    const warmed = MockClaudeProcess.spawned.at(-1)!

    const session = await manager.createSession({ ...baseRequest, customEnvVars: { API_BASE: 'two' } })

    expect(session.id).not.toBe(warmed.sessionId)
    expect(warmed.disposeCalls).toBe(1)
  })

  // The process is spawned with a snapshot of the environment, so one that is
  // still spawning when /env writes is just as stale as a parked one — and its
  // profile is unchanged, so nothing else would reject it.
  it('rejects a warm-up that was already spawning when the environment changed', async () => {
    let release!: () => void
    prewarmGate = new Promise<void>((r) => (release = r))

    await manager.createSession(baseRequest)
    const inFlight = MockClaudeProcess.spawned.at(-1)!

    await manager.discardPrewarmed('env var REMOTE_MCPS changed')
    release()

    await vi.waitFor(() => expect(inFlight.disposeCalls).toBe(1))
    // And nothing stale is left parked for the next session to claim.
    prewarmGate = null
    const session = await manager.createSession(baseRequest)
    expect(session.id).not.toBe(inFlight.sessionId)
  })

  // Otherwise a CLI nobody can use sits on memory until the next createSession.
  it('disposes a warm-up that finishes after a session asked for something else', async () => {
    let release!: () => void
    prewarmGate = new Promise<void>((r) => (release = r))

    // The refill for this session is now parked mid-spawn.
    await manager.createSession(baseRequest)
    const warmed = MockClaudeProcess.spawned.at(-1)!

    // A session with different parameters arrives first and starts cold.
    prewarmGate = null
    const session = await manager.createSession({ ...baseRequest, model: 'claude-sonnet-5' })
    expect(session.id).not.toBe(warmed.sessionId)

    release()
    await vi.waitFor(() => expect(warmed.disposeCalls).toBe(1))
  })

  // Nothing references the parked process, so only shutdown can reap it.
  it('disposes the parked process on shutdown instead of orphaning it', async () => {
    await manager.createSession(baseRequest)
    const warmed = MockClaudeProcess.spawned.at(-1)!

    await manager.stopAll()

    expect(warmed.disposeCalls).toBe(1)
  })

  it('does not pre-warm when disabled', async () => {
    const off = new SessionManager(workDir, {
      idleEvictionMs: -1,
      automatedIdleEvictionMs: -1,
      prewarmEnabled: false,
    })
    MockClaudeProcess.spawned = []

    await off.createSession(baseRequest)

    expect(MockClaudeProcess.spawned).toHaveLength(1)
    expect(MockClaudeProcess.spawned[0].prewarmCalls).toBe(0)
    await off.stopAll()
  })
})
