import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingUserInputRequest, UserInputRequestOutcome } from '@shared/lib/tools/requests/request-schema'
import { getSessionSummaryCacheSlot } from '@shared/lib/services/session-summary-cache'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'
import { ReviewManager } from '@shared/lib/proxy/review-manager'
import { AccountReauthManager } from '@shared/lib/proxy/account-reauth-manager'
import { McpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import { ComputerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import type { AgentSessionsAccess } from '@shared/lib/container/agent-sessions-access'
import { createAgentRegistry } from './registry'
import type { AgentState } from './agent-state'
import type { LocalActorDeps, LocalAgentActor } from './local-agent-actor'
import type { SessionStore } from './session-store'
import { createRecordingHostPort } from './testing/recording-host-port'

// The singleton registry wires the real container host. These tests build
// their own registry from fakes, so that module is stubbed to keep the
// import side-effect free. The per-agent stores (input requests, reviews,
// re-auth waits, computer-use grants) and the routers over them are real:
// they are the actor's own and are what the tests below exercise.
vi.mock('@shared/lib/container/container-host', () => ({ containerHost: { attachAgentWorkspaces: () => {}, attachAgentSessions: () => {} } }))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: () => ({}), mutateSettings: vi.fn() }))
vi.mock('@shared/lib/services/session-service', () => ({}))
vi.mock('@shared/lib/services/session-transcript-append', () => ({
  appendInformationalEntry: vi.fn(),
  appendAssistantEntry: vi.fn(),
}))
vi.mock('@shared/lib/services/session-summary-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/services/session-summary-cache')>()),
  recordSessionActivity: vi.fn(),
}))
vi.mock('./local-transcript-ops', () => ({
  listSubagents: vi.fn(),
  readSubagentTranscript: vi.fn(),
  readWorkflowTree: vi.fn(),
  readWorkflowAgentTranscript: vi.fn(),
  copyDerivedSessionFiles: vi.fn(),
  streamRawEntries: vi.fn(),
  openRawLog: vi.fn(),
  openMedia: vi.fn(),
}))
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentWorkspaceDir: vi.fn(),
  getAgentClaudeConfigDir: vi.fn(),
  getSessionJsonlPath: vi.fn(),
}))
vi.mock('@shared/lib/container/connection-runtime-sync', () => ({
  updateConnectedAccountsEnvironment: vi.fn(),
  updateRemoteMcpEnvironment: vi.fn(),
  syncAgentConnectionEnvironment: vi.fn(),
}))
vi.mock('@shared/lib/services/usage-service', () => ({ loadDailyUsageData: vi.fn(), loadSessionUsageTotals: vi.fn() }))

type FakeRequest = {
  id: string
  kind: PendingUserInputRequest['kind']
  scope: { agentSlug?: string; sessionId?: string }
  payload: Record<string, unknown>
}

/**
 * The routers the registry attaches to. The user-input router is the module
 * singleton: the review router's owner lookup goes through it, so the one the
 * actors report to must be the one it consults. Spied, so a test can see what
 * the stores reported and what the registry attached.
 */
function routers() {
  const inputManager = userInputRequestManager
  vi.spyOn(inputManager, 'report')
  vi.spyOn(inputManager, 'attachAgents')
  const reviewManager = new ReviewManager()
  vi.spyOn(reviewManager, 'attachAgents')
  const accountReauthManager = new AccountReauthManager()
  vi.spyOn(accountReauthManager, 'attachAgents')
  const mcpReauthManager = new McpReauthManager()
  vi.spyOn(mcpReauthManager, 'attachAgents')
  const computerUsePermissionManager = new ComputerUsePermissionManager()
  vi.spyOn(computerUsePermissionManager, 'attachAgents')
  return {
    inputManager: inputManager as typeof inputManager & {
      report: ReturnType<typeof vi.fn>
      attachAgents: ReturnType<typeof vi.fn>
    },
    reviewManager,
    accountReauthManager,
    mcpReauthManager,
    computerUsePermissionManager,
  }
}

function fakeDeps() {
  const client = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 200 })),
    getHostAuthHeaders: vi.fn().mockReturnValue({ 'x-host': '1' }),
    getWebSocketBaseUrl: vi.fn().mockReturnValue('ws://127.0.0.1:4321'),
  }
  // One fake runtime per slug, created the way the real host creates them: on first use.
  const fakeRuntime = (slug: string) => ({
    slug,
    getClient: vi.fn().mockReturnValue(client),
    ensureRunning: vi.fn().mockResolvedValue(client),
    getCachedInfo: vi.fn().mockReturnValue({ status: 'running', port: 4321 }),
    keepAlive: vi.fn(),
    noteSessionActivity: vi.fn(),
    idleSince: vi.fn<() => number | null>().mockReturnValue(null),
    getHealthWarnings: vi.fn().mockReturnValue([]),
    isStale: vi.fn().mockReturnValue(false),
    markStale: vi.fn(),
    restartContainer: vi.fn().mockResolvedValue(undefined),
  })
  const runtimes = new Map<string, ReturnType<typeof fakeRuntime>>()
  const containerHost = {
    runtime: vi.fn((slug: string) => {
      let runtime = runtimes.get(slug)
      if (!runtime) {
        runtime = fakeRuntime(slug)
        runtimes.set(slug, runtime)
      }
      return runtime
    }),
    getRunningAgentIds: vi.fn().mockReturnValue([]),
    dropRuntime: vi.fn(),
    clearRuntimes: vi.fn(),
    attachAgentWorkspaces: vi.fn(),
    attachAgentSessions: vi.fn(),
  }
  const { inputManager, reviewManager, accountReauthManager, mcpReauthManager, computerUsePermissionManager } =
    routers()
  const loadDailyUsageData = vi.fn().mockResolvedValue([])
  const loadSessionUsageTotals = vi.fn().mockResolvedValue({ totalCost: 0, totalTokens: 0, priceMissing: false })
  const syncAgentConnectionEnvironment = vi.fn().mockResolvedValue(true)
  const transcripts = {
    listSubagents: vi.fn().mockResolvedValue([{ id: 'sub-1', toolUseId: 'tu-1' }]),
    readSubagentTranscript: vi.fn().mockResolvedValue([]),
    readWorkflowTree: vi.fn().mockResolvedValue(null),
    readWorkflowAgentTranscript: vi.fn().mockResolvedValue([]),
    copyDerivedSessionFiles: vi.fn().mockResolvedValue(undefined),
    streamRawEntries: vi.fn(),
    openRawLog: vi.fn().mockResolvedValue(null),
    openMedia: vi.fn().mockResolvedValue(undefined),
  }
  const appendAssistantEntry = vi.fn()
  const recordSessionActivity = vi.fn()
  // What the agents' live sessions send the host (request events, notifications).
  const host = createRecordingHostPort()
  const deps = {
    containerHost,
    host: host.port,
    userInputRequestManager: inputManager,
    reviewManager,
    accountReauthManager,
    computerUsePermissionManager,
    mcpReauthManager,
    sessionService: {},
    transcripts,
    appendInformationalEntry: vi.fn(),
    appendAssistantEntry,
    recordSessionActivity,
    getAgentWorkspaceDir: vi.fn((slug: string) => `/workspaces/${slug}`),
    syncAgentConnectionEnvironment,
    loadDailyUsageData,
    loadSessionUsageTotals,
  }
  return {
    deps: deps as unknown as LocalActorDeps,
    containerHost,
    runtimes,
    client,
    reviewManager,
    inputManager,
    loadDailyUsageData,
    loadSessionUsageTotals,
    syncAgentConnectionEnvironment,
    transcripts,
    appendAssistantEntry,
    recordSessionActivity,
  }
}

const outcome = { kind: 'settled' } as unknown as UserInputRequestOutcome

describe('createAgentRegistry', () => {
  let fake: ReturnType<typeof fakeDeps>

  beforeEach(() => {
    vi.restoreAllMocks()
    userInputRequestManager.reset()
    fake = fakeDeps()
  })

  it('returns one stable handle per slug, created on first get', () => {
    const registry = createAgentRegistry(fake.deps)
    const a = registry.get('a')
    expect(a.slug).toBe('a')
    expect(registry.get('a')).toBe(a)
    expect(registry.get('b')).not.toBe(a)
    // A handle does not touch the container host until an op runs.
    expect(fake.containerHost.runtime).not.toHaveBeenCalled()
  })


  it('binds memory operations to each actor without starting a container', async () => {
    const registry = createAgentRegistry(fake.deps)
    const a = registry.get('a')
    const b = registry.get('b')
    const resolveA = vi.spyOn(a.files, 'resolve').mockResolvedValue(null)
    const resolveB = vi.spyOn(b.files, 'resolve').mockResolvedValue(null)
    const { list, read, save } = a.memories
    expect(await list()).toEqual([])
    expect(resolveA).toHaveBeenCalledWith('.claude/projects/-workspace/memory')
    expect(resolveB).not.toHaveBeenCalled()
    await expect(read('missing.md')).rejects.toMatchObject({ status: 404 })
    await expect(save('missing.md', 'draft', 'revision')).rejects.toMatchObject({ status: 404 })
    expect(await b.memories.list()).toEqual([])
    expect(resolveB).toHaveBeenCalledTimes(1)
    expect(a.memories).toBe(registry.get('a').memories)
    expect(a.memories).not.toBe(b.memories)
    expect(fake.containerHost.runtime).not.toHaveBeenCalled()
  })
  it('gives the container host a way into each agent workspace through the actors', async () => {
    const registry = createAgentRegistry(fake.deps)
    expect(fake.containerHost.attachAgentWorkspaces).toHaveBeenCalledTimes(1)
    const access = fake.containerHost.attachAgentWorkspaces.mock.calls[0][0] as {
      files: (slug: string) => unknown
      instructions: (slug: string) => Promise<string | null>
    }
    // The same file operations the actor hands out, for the same agent.
    expect(access.files('a')).toBe(registry.get('a').files)
    expect(access.files('b')).not.toBe(registry.get('a').files)
    // Instructions are the actor's config document.
    const getDoc = vi.spyOn(registry.get('a').config, 'get').mockResolvedValue('---\nname: A\n---\n')
    expect(await access.instructions('a')).toBe('---\nname: A\n---\n')
    expect(getDoc).toHaveBeenCalledWith('instructions')
  })

  describe('the container host reaches the held agents\' live sessions', () => {
    const attached = () => {
      expect(fake.containerHost.attachAgentSessions).toHaveBeenCalledTimes(1)
      return fake.containerHost.attachAgentSessions.mock.calls[0][0] as AgentSessionsAccess
    }

    it('peeking never creates a handle', () => {
      createAgentRegistry(fake.deps)
      expect(attached().peek('a')).toBeUndefined()
      expect(attached().peek('a')).toBeUndefined()
    })

    it('peeking a held agent answers its actor\'s live sessions', () => {
      const registry = createAgentRegistry(fake.deps)
      const a = registry.get('a') as LocalAgentActor
      const b = registry.get('b') as LocalAgentActor
      expect(attached().peek('a')).toBe(a.state.sessions)
      expect(attached().peek('b')).toBe(b.state.sessions)
    })

    it('an evicted agent has no live sessions to peek', async () => {
      const registry = createAgentRegistry(fake.deps)
      registry.get('a')
      await registry.evict('a')
      expect(attached().peek('a')).toBeUndefined()
    })
  })

  it('evict drops the handle and forgets the runtime for that slug only', async () => {
    const registry = createAgentRegistry(fake.deps)
    const a = registry.get('a')
    const b = registry.get('b')

    await registry.evict('a')

    expect(fake.containerHost.dropRuntime).toHaveBeenCalledWith('a')
    expect(registry.get('b')).toBe(b)
    expect(registry.get('a')).not.toBe(a)
  })

  it('evictAll clears every handle and every runtime', async () => {
    const registry = createAgentRegistry(fake.deps)
    const a = registry.get('a')
    const b = registry.get('b')

    await registry.evictAll()

    expect(fake.containerHost.clearRuntimes).toHaveBeenCalledTimes(1)
    expect(registry.get('a')).not.toBe(a)
    expect(registry.get('b')).not.toBe(b)
  })

  describe('passthroughs reach this agent\'s runtime and keep the client inside', () => {
    it('container.start resolves to nothing even though ensureRunning returns the client', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      await expect(actor.container.start()).resolves.toBeUndefined()
      expect(fake.containerHost.runtime).toHaveBeenCalledWith('a')
      expect(fake.runtimes.get('a')?.ensureRunning).toHaveBeenCalledTimes(1)
    })

    it('sessions.broadcastUpdate, and the awaiting re-sync after inputs.resolve, reach this agent\'s live sessions only', async () => {
      const registry = createAgentRegistry(fake.deps)
      const actor = registry.get('a') as LocalAgentActor
      const other = (registry.get('b') as LocalAgentActor).state.sessions
      const emit = vi.spyOn(actor.state.sessions, 'emit')
      const syncAwaiting = vi.spyOn(actor.state.sessions, 'syncAwaiting')
      const otherEmit = vi.spyOn(other, 'emit')
      const otherSyncAwaiting = vi.spyOn(other, 'syncAwaiting')
      await actor.sessions.broadcastUpdate('s1')
      await actor.inputs.resolve('nothing-open', 'answered')
      expect(emit).toHaveBeenCalledWith('s1', { type: 'session_updated' })
      expect(syncAwaiting).toHaveBeenCalledTimes(1)
      expect(otherEmit).not.toHaveBeenCalled()
      expect(otherSyncAwaiting).not.toHaveBeenCalled()
    })

    it('container.webSocketTarget targets this agent\'s container and adds its auth headers last', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      expect(fake.containerHost.runtime).not.toHaveBeenCalled()

      expect(await actor.container.webSocketTarget('/browser/stream', {
        search: '?since=1',
        protocols: ['p1'],
        headers: { 'x-forwarded': 'yes', 'x-host': 'spoofed' },
      })).toEqual({
        url: 'ws://127.0.0.1:4321/browser/stream?since=1',
        protocols: ['p1'],
        headers: { 'x-forwarded': 'yes', 'x-host': '1' },
      })
      expect(fake.runtimes.get('a')?.getCachedInfo).toHaveBeenCalledTimes(1)
      expect(fake.client.getWebSocketBaseUrl).toHaveBeenCalledWith(4321)
    })

    it('container.webSocketTarget has none while the container is not running', async () => {
      fake.containerHost.runtime('a').getCachedInfo.mockReturnValue({ status: 'stopped', port: null })
      const actor = createAgentRegistry(fake.deps).get('a')
      expect(await actor.container.webSocketTarget('/browser/stream')).toBeNull()
    })

    it('container.syncConnectionEnvironment pushes one projection through this agent\'s runtime', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      await expect(actor.container.syncConnectionEnvironment('remote-mcps')).resolves.toBe(true)
      expect(fake.syncAgentConnectionEnvironment).toHaveBeenCalledWith('a', 'remote-mcps', fake.runtimes.get('a'))
    })

    it('usage.daily reads every transcript the CLI wrote for this agent', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      await actor.usage.daily({ since: '2026-09-01' })
      expect(fake.loadDailyUsageData).toHaveBeenCalledWith({
        files: actor.files,
        dir: '.claude/projects/-workspace',
        since: '2026-09-01',
      })
    })

    it('sessions.usage reads this session\'s transcript through the agent\'s files', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      await actor.sessions.usage('s1')
      expect(fake.loadSessionUsageTotals).toHaveBeenCalledWith({
        files: actor.files,
        transcript: '.claude/projects/-workspace/s1.jsonl',
      })
    })

    it('hands the live sessions this agent\'s session store, the one its own reads use', () => {
      const registry = createAgentRegistry(fake.deps)
      const actor = registry.get('a') as LocalAgentActor
      const other = registry.get('b') as LocalAgentActor
      // The store is the sessions' own dependency, not on their public surface.
      const storeOf = (handle: LocalAgentActor) =>
        (handle.state.sessions as unknown as { deps: { store: SessionStore } }).deps.store
      const store = storeOf(actor)
      expect(store).toBe(actor.store)
      expect(store.slug).toBe('a')
      expect(store.files).toBe(actor.files)
      expect(store.transcriptsDir).toBe('.claude/projects/-workspace')
      expect(storeOf(other)).toBe(other.store)
    })

    it('inputs.reviews.request parks the review on the actor\'s own store under its slug', async () => {
      const actor = createAgentRegistry(fake.deps).get('a') as LocalAgentActor
      const syncAwaiting = vi.spyOn(actor.state.sessions, 'syncAwaiting')
      const details = {
        accountId: 'acct',
        toolkit: 'gmail',
        method: 'GET',
        targetPath: '/messages',
        matchedScopes: ['read'],
        scopeDescriptions: {},
      }
      const decision = actor.inputs.reviews.request(details, { id: 'review-1' })
      const [open] = actor.state.inputRequests.getOpenRequests()
      expect(open).toMatchObject({ kind: 'proxy_review', scope: { agentSlug: 'a' }, payload: { ...details, agentSlug: 'a' } })
      expect((await actor.live()).pendingReviews.map((r) => r.id)).toEqual([open.id])
      expect(await actor.inputs.reviews.get(open.id)).toMatchObject({ id: open.id, ...details })
      // The transition reached the router, which is how the wire hears of it.
      expect(fake.inputManager.report).toHaveBeenCalledWith(expect.objectContaining({ type: 'created', request: open }))
      expect(await actor.inputs.reviews.submit(open.id, 'allow')).toBe(true)
      await expect(decision).resolves.toBe('allow')
      // The review opening and closing changed whether the agent's sessions wait.
      expect(syncAwaiting).toHaveBeenCalled()
    })

    it('transcript-adjacent reads bind the session store and forward the rest', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      const store = expect.objectContaining({ slug: 'a', files: actor.files })
      const except = new Set(['known'])
      await expect(actor.sessions.subagents('s1', { except })).resolves.toEqual([{ id: 'sub-1', toolUseId: 'tu-1' }])
      expect(fake.transcripts.listSubagents).toHaveBeenCalledWith(store, 's1', { except })
      await actor.sessions.workflowAgentTranscript('s1', 'wf_1', 'agent-x')
      expect(fake.transcripts.readWorkflowAgentTranscript).toHaveBeenCalledWith(store, 's1', 'wf_1', 'agent-x')
      await actor.sessions.copyDerivedFiles('s1', 's2')
      expect(fake.transcripts.copyDerivedSessionFiles).toHaveBeenCalledWith(store, 's1', 's2')
      const signal = new AbortController().signal
      await actor.messages.media('s1', { kind: 'x' } as never, signal)
      expect(fake.transcripts.openMedia).toHaveBeenCalledWith(store, 's1', { kind: 'x' }, signal)
    })

    it('appendAssistant and recordActivity reach the transcript writers with the session store', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      const store = expect.objectContaining({ slug: 'a', files: actor.files })
      await actor.messages.appendAssistant('s1', 'delivered elsewhere')
      expect(fake.appendAssistantEntry).toHaveBeenCalledWith(store, 's1', 'delivered elsewhere')
      await actor.sessions.recordActivity('s1')
      expect(fake.recordSessionActivity).toHaveBeenCalledWith(store, 's1')
      await actor.sessions.recordActivity('s1', 1234)
      expect(fake.recordSessionActivity).toHaveBeenCalledWith(store, 's1', 1234)
    })
  })

  describe('the idle clock is the actor\'s own', () => {
    it('is answered by this agent\'s runtime', async () => {
      fake.containerHost.runtime('a').idleSince.mockReturnValue(1_000)
      const registry = createAgentRegistry(fake.deps)
      expect((await registry.get('a').live()).container.idleSince).toBe(1_000)
      expect((await registry.get('b').live()).container.idleSince).toBeNull()
    })

    it('hears of every session write through the store and marks the runtime', () => {
      const registry = createAgentRegistry(fake.deps)
      const actor = registry.get('a') as LocalAgentActor
      actor.store.onActivity?.(5_000)
      expect(fake.runtimes.get('a')?.noteSessionActivity).toHaveBeenCalledWith(5_000)
      // Another agent's store marks another agent's runtime.
      ;(registry.get('b') as LocalAgentActor).store.onActivity?.(6_000)
      expect(fake.runtimes.get('b')?.noteSessionActivity).toHaveBeenCalledWith(6_000)
      expect(fake.runtimes.get('a')?.noteSessionActivity).toHaveBeenCalledTimes(1)
    })

    it('sessions.markIdle marks the runtime before the session goes idle', async () => {
      const actor = createAgentRegistry(fake.deps).get('a') as LocalAgentActor
      const markIdle = vi.spyOn(actor.state.sessions, 'markIdle')
      await actor.sessions.markIdle('s1')
      const noteSessionActivity = fake.runtimes.get('a')!.noteSessionActivity
      expect(noteSessionActivity).toHaveBeenCalledTimes(1)
      expect(markIdle).toHaveBeenCalledWith('s1')
      expect(noteSessionActivity.mock.invocationCallOrder[0]).toBeLessThan(markIdle.mock.invocationCallOrder[0])
    })
  })

  describe('inputs are the handle\'s own', () => {
    const request = (id: string, agentSlug: string): FakeRequest => ({
      id,
      kind: 'question' as PendingUserInputRequest['kind'],
      scope: { agentSlug, sessionId: 's' },
      payload: {},
    })
    const register = (registry: ReturnType<typeof createAgentRegistry>, slug: string, id: string) =>
      registry.get(slug).inputs.register({ ...request(id, slug), blocking: true } as never)

    it('register stamps this agent onto the scope, whatever the caller wrote, and reports the transition', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      const stored = await actor.inputs.register({ ...request('r1', 'b'), blocking: true } as never)
      expect(stored).toMatchObject({ id: 'r1', scope: { agentSlug: 'a', sessionId: 's' } })
      expect((await actor.sessions.live('s')).openRequests.map((r) => r.id)).toEqual(['r1'])
      expect(fake.inputManager.report).toHaveBeenCalledWith({ type: 'created', request: stored })
    })

    it('another agent\'s request is not found: get, claim, enrich and resolve miss and leave it untouched', async () => {
      const registry = createAgentRegistry(fake.deps)
      const stored = await register(registry, 'b', 'rb')
      const a = registry.get('a').inputs

      expect(await a.get('rb')).toBeNull()
      expect(await a.claim('rb')).toBeNull()
      expect(await a.enrich('rb', 'question' as PendingUserInputRequest['kind'], { note: 1 })).toBe(false)
      expect(await a.resolve('rb', outcome)).toBeNull()
      expect(await a.snapshot()).toEqual([])

      expect(await registry.get('b').inputs.get('rb')).toBe(stored)
      expect(stored!.payload).toEqual({})
    })

    it('the owning agent can still see, claim, settle and read back its own request', async () => {
      const registry = createAgentRegistry(fake.deps)
      await register(registry, 'b', 'rb')
      const b = registry.get('b').inputs

      expect((await b.get('rb'))?.id).toBe('rb')
      expect((await b.claim('rb'))?.request.id).toBe('rb')
      expect(await b.enrich('rb', 'question' as PendingUserInputRequest['kind'], { note: 1 })).toBe(true)
      expect((await b.resolve('rb', outcome))?.id).toBe('rb')
      expect((await b.recentResolution('rb'))?.id).toBe('rb')
      // The settled record is the owner's too: another agent cannot read it back.
      expect(await registry.get('a').inputs.recentResolution('rb')).toBeUndefined()
    })

    it('releaseClaim only drops a claim this agent could have taken', async () => {
      const registry = createAgentRegistry(fake.deps)
      await register(registry, 'b', 'rb')
      const claim = await registry.get('b').inputs.claim('rb')
      expect(claim?.request.id).toBe('rb')

      await registry.get('a').inputs.releaseClaim('rb', claim!.token)
      expect(await registry.get('b').inputs.claim('rb')).toBeNull()

      await registry.get('b').inputs.releaseClaim('rb', claim!.token)
      expect((await registry.get('b').inputs.claim('rb'))?.request.id).toBe('rb')
    })
  })

  describe('the registry attaches the routers to the handles\' stores', () => {
    it('gives every router a directory that reads through the handles and creates none of its own', async () => {
      const registry = createAgentRegistry(fake.deps)
      for (const router of [
        fake.inputManager,
        fake.reviewManager,
        fake.deps.accountReauthManager,
        fake.deps.mcpReauthManager,
        fake.deps.computerUsePermissionManager,
      ]) {
        expect(router.attachAgents).toHaveBeenCalledTimes(1)
      }
      const directory = fake.inputManager.attachAgents.mock.calls[0]![0] as {
        get: (slug: string) => unknown
        peek: (slug: string) => unknown
        all: () => unknown[]
      }
      expect(directory.all()).toEqual([])
      expect(directory.peek('a')).toBeUndefined()
      // A router's `get` is a first use like any other: it creates the handle.
      const store = directory.get('a')
      expect(store).toBe((registry.get('a') as LocalAgentActor).state.inputRequests)
      expect(directory.peek('a')).toBe(store)
      expect(directory.all()).toEqual([store])
      await registry.evict('a')
      expect(directory.all()).toEqual([])
    })
  })

  describe('a registry built over an earlier registry\'s state (a dev-server reload)', () => {
    it('wraps every surviving state in a fresh handle, visible to the routers at once', async () => {
      const states = new Map<string, AgentState>()
      const before = createAgentRegistry(fake.deps, { states })
      const actor = before.get('a') as LocalAgentActor
      await actor.inputs.register({ id: 'q1', kind: 'question', scope: { sessionId: 's' }, blocking: true, payload: {} } as never)
      expect(states.get('a')).toBe(actor.state)

      const after = createAgentRegistry(fake.deps, { states })
      const rebuilt = after.get('a') as LocalAgentActor
      expect(rebuilt).not.toBe(actor)
      expect(rebuilt.state).toBe(actor.state)
      expect((await rebuilt.inputs.get('q1'))?.id).toBe('q1')
      // The new registry's directory sees the rebuilt handle without a `get`:
      // the last attach is the new registry's.
      const directory = fake.inputManager.attachAgents.mock.calls.at(-1)![0] as { all: () => unknown[] }
      expect(directory.all()).toEqual([rebuilt.state.inputRequests])

      await after.evict('a')
      expect(states.has('a')).toBe(false)
      expect(await after.get('a').inputs.get('q1')).toBeNull()
    })
  })

  describe('evict releases everything the handle owns', () => {
    const reviewDetails = {
      accountId: 'acct',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/messages',
      matchedScopes: ['read'],
      scopeDescriptions: {},
    }

    it('settles every open request, rejects every parked call, and forgets the grants and the summary', async () => {
      const registry = createAgentRegistry(fake.deps)
      const actor = registry.get('a') as LocalAgentActor

      // Plant state of every kind the actor owns.
      await actor.inputs.register({ id: 'q1', kind: 'question', scope: { sessionId: 's' }, blocking: true, payload: {} } as never)
      const review = actor.inputs.reviews.request(reviewDetails, { id: 'review-1' })
      const account = actor.inputs.accountReauth.request({ accountId: 'acct', toolkit: 'gmail', accountStatus: 'expired' }, { waitId: 'wait-1' })
      const mcp = actor.inputs.mcpReauth.request({ mcpId: 'm1', mcpName: 'Cal', authType: 'oauth' }, { waitId: 'wait-2' })
      await actor.inputs.computerUse.grant('use_host_shell', 'once')
      await actor.inputs.computerUse.setGrabbedApp('Calculator')
      getSessionSummaryCacheSlot(actor.store).revision = 7
      expect((await actor.live()).openRequests).toHaveLength(4)
      fake.inputManager.report.mockClear()
      const syncAwaiting = vi.spyOn(actor.state.sessions, 'syncAwaiting')
      const dispose = vi.spyOn(actor.state.sessions, 'dispose')

      await registry.evict('a')

      await expect(review).resolves.toBe('timeout')
      await expect(account).resolves.toEqual({ outcome: 'cancelled', message: expect.stringMatching(/no longer held by this process/) })
      await expect(mcp).resolves.toEqual({ outcome: 'cancelled', message: expect.stringMatching(/no longer held by this process/) })
      // Every settlement went out as a transition, so the wire and the index heard of it.
      const resolved = fake.inputManager.report.mock.calls
        .map(([transition]) => transition as { type: string; request: { id: string; kind: string }; outcome?: string })
        .filter((t) => t.type === 'resolved')
      expect(resolved.map((t) => t.request.kind).sort()).toEqual([
        'account_reauth_required',
        'mcp_reauth_required',
        'proxy_review',
        'question',
      ])
      expect(resolved.find((t) => t.request.id === 'q1')?.outcome).toBe('invalidated')
      expect(syncAwaiting).toHaveBeenCalled()
      // The live sessions are released with it: their streams and timers go.
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(fake.containerHost.dropRuntime).toHaveBeenCalledWith('a')

      // Nothing survives into the next handle for the slug.
      const fresh = registry.get('a') as LocalAgentActor
      expect(fresh).not.toBe(actor)
      const freshLive = await fresh.live()
      expect(freshLive.openRequests).toEqual([])
      expect(freshLive.pendingReviews).toEqual([])
      expect(await fresh.inputs.recentResolution('q1')).toBeUndefined()
      expect(fresh.state.computerUse.grabbed()).toBeUndefined()
      expect(fresh.state.computerUse.activeGrants()).toEqual([])
      expect(fresh.state.accountReauth.openEntryIds()).toEqual([])
      expect(fresh.state.mcpReauth.openEntryIds()).toEqual([])
      expect(getSessionSummaryCacheSlot(fresh.store).revision).toBe(0)
      // And the old handle holds nothing either.
      expect((await actor.live()).openRequests).toEqual([])
      expect(actor.state.reviews.settlerIds()).toEqual([])
    })

    it('evictAll evicts every handle the same way', async () => {
      const registry = createAgentRegistry(fake.deps)
      const a = registry.get('a')
      const b = registry.get('b')
      const reviewA = a.inputs.reviews.request(reviewDetails, { id: 'review-a' })
      const reviewB = b.inputs.reviews.request(reviewDetails, { id: 'review-b' })

      await registry.evictAll()

      await expect(reviewA).resolves.toBe('timeout')
      await expect(reviewB).resolves.toBe('timeout')
      // The host forgets the runtimes its own way (a starting one is kept).
      expect(fake.containerHost.dropRuntime).not.toHaveBeenCalled()
      expect(fake.containerHost.clearRuntimes).toHaveBeenCalledTimes(1)
      expect(registry.get('a')).not.toBe(a)
      expect(registry.get('b')).not.toBe(b)
    })
  })

  describe('reads consumed together are one snapshot', () => {
    it('live() is the agent as of now: its container, busy sessions, open asks and reviews', async () => {
      fake.containerHost.runtime('a').getHealthWarnings.mockReturnValue([{ checkName: 'disk', status: 'warning' }])
      fake.containerHost.runtime('a').isStale.mockReturnValue(true)
      const actor = createAgentRegistry(fake.deps).get('a') as LocalAgentActor
      actor.state.sessions.markActive('s-busy')
      await actor.inputs.register({ id: 'q1', kind: 'question', scope: { sessionId: 's-busy' }, blocking: true, payload: { secret: 1 } } as never)
      void actor.inputs.reviews.request(
        { accountId: 'acct', toolkit: 'gmail', method: 'GET', targetPath: '/m', matchedScopes: ['read'], scopeDescriptions: {} },
        { id: 'review-1' },
      )

      const live = await actor.live()

      expect(live.container).toEqual({ status: 'running', port: 4321, healthWarnings: [{ checkName: 'disk', status: 'warning' }], stale: true, idleSince: null })
      expect(live.activeSessionIds).toEqual(['s-busy'])
      expect(live.awaitingSessionIds).toEqual(['s-busy'])
      // Without payloads: a status view has no use for them.
      expect(live.openRequests).toContainEqual({ id: 'q1', kind: 'question', blocking: true, autoApproved: false, sessionId: 's-busy' })
      expect(live.openRequests.every((request) => !('payload' in request))).toBe(true)
      expect(live.pendingReviews).toEqual([{ id: expect.any(String), displayText: expect.any(String) }])
    })

    it('sessions.live() is one session as of now, with its requests and the runtime recorded for it', async () => {
      const registry = createAgentRegistry(fake.deps)
      const actor = registry.get('a') as LocalAgentActor
      expect(await actor.sessions.live('s1')).toEqual({
        activity: 'idle', isActive: false, isAwaitingInput: false, streamAttached: false, openRequests: [], runtime: null,
      })

      actor.state.sessions.markActive('s1')
      await actor.inputs.register({ id: 'q1', kind: 'question', scope: { sessionId: 's1' }, blocking: true, payload: { q: 1 } } as never)
      await actor.sessions.recordRuntime('s1', { provider: 'anthropic', modelContextWindows: { m: 1 } })

      expect(await actor.sessions.live('s1')).toMatchObject({
        isActive: true,
        openRequests: [expect.objectContaining({ id: 'q1', payload: { q: 1 } })],
        runtime: { provider: 'anthropic', modelContextWindows: { m: 1 } },
      })
      // Another agent's session of the same id is not this one.
      expect((await registry.get('b').sessions.live('s1')).runtime).toBeNull()
    })
  })

  describe('a read → decide → write is one op', () => {
    it('container.invalidate marks a running container stale, restarts it when asked, and leaves a stopped one', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      const runtime = fake.containerHost.runtime('a')
      expect(await actor.container.invalidate()).toBe('marked-stale')
      expect(runtime.markStale).toHaveBeenCalledOnce()
      expect(await actor.container.invalidate({ restart: true })).toBe('restarted')
      expect(runtime.restartContainer).toHaveBeenCalledOnce()
      runtime.getCachedInfo.mockReturnValue({ status: 'stopped', port: null })
      expect(await actor.container.invalidate({ restart: true })).toBe('not-running')
      expect(runtime.restartContainer).toHaveBeenCalledOnce()
    })

    it('inputs.register unlessRecentlyResolved does not park again a request just decided', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      const input = { id: 'q1', kind: 'question', scope: { sessionId: 's' }, blocking: true, payload: {} } as never
      await actor.inputs.register(input)
      await actor.inputs.resolve('q1', 'answered')
      expect(await actor.inputs.register(input, { unlessRecentlyResolved: true })).toBeNull()
      expect(await actor.inputs.get('q1')).toBeNull()
      // Without the option a decided id can be asked again.
      expect((await actor.inputs.register(input))?.id).toBe('q1')
    })

    describe('inputs.answer', () => {
      const ask = (actor: LocalAgentActor) =>
        actor.inputs.register({ id: 'q1', kind: 'question', scope: { sessionId: 's' }, blocking: true, payload: {} } as never)

      it('hands the value to the container and settles the request', async () => {
        const actor = createAgentRegistry(fake.deps).get('a') as LocalAgentActor
        ask(actor)
        const complete = vi.spyOn(actor.state.sessions, 'completeRequest')

        expect(await actor.inputs.answer('q1', 'yes')).toBe('answered')

        expect(fake.client.fetch).toHaveBeenCalledWith('/inputs/q1/resolve', expect.objectContaining({ method: 'POST', body: JSON.stringify({ value: 'yes' }) }))
        expect(complete).toHaveBeenCalledWith(undefined, 'q1', 'answered')
      })

      it('answers nothing open, and leaves a request another decision holds', async () => {
        const actor = createAgentRegistry(fake.deps).get('a') as LocalAgentActor
        expect(await actor.inputs.answer('q1', 'yes')).toBe('not-open')
        ask(actor)
        const held = await actor.inputs.claim('q1')
        expect(await actor.inputs.answer('q1', 'yes')).toBe('claimed')
        expect(fake.client.fetch).not.toHaveBeenCalled()
        await actor.inputs.releaseClaim('q1', held!.token)
      })

      it('does not answer a request settled on another surface while the container started', async () => {
        const actor = createAgentRegistry(fake.deps).get('a') as LocalAgentActor
        ask(actor)
        fake.containerHost.runtime('a').ensureRunning.mockImplementationOnce(async () => {
          await actor.inputs.resolve('q1', 'answered')
          return fake.client
        })
        expect(await actor.inputs.answer('q1', 'yes')).toBe('not-open')
        expect(fake.client.fetch).not.toHaveBeenCalled()
      })

      it('keeps the request open, and its claim free, when the container will not take the answer', async () => {
        const actor = createAgentRegistry(fake.deps).get('a') as LocalAgentActor
        ask(actor)
        fake.client.fetch.mockResolvedValueOnce(new Response('gone', { status: 404 }))
        vi.spyOn(console, 'error').mockImplementationOnce(() => {})
        expect(await actor.inputs.answer('q1', 'yes')).toBe('undeliverable')
        expect((await actor.inputs.get('q1'))?.id).toBe('q1')
        expect(await actor.inputs.claim('q1')).not.toBeNull()
      })
    })

    it('computerUse.releaseGrab forgets the grab, revokes the app and tells the session\'s viewers', async () => {
      const actor = createAgentRegistry(fake.deps).get('a') as LocalAgentActor
      await actor.inputs.computerUse.grant('use_application', 'always', 'Calculator')
      await actor.inputs.computerUse.setGrabbedApp('Calculator')
      const emit = vi.spyOn(actor.state.sessions, 'emit')
      const revoke = vi.spyOn(actor.state.computerUse, 'revoke')

      expect(await actor.inputs.computerUse.releaseGrab('s1')).toEqual({ appName: 'Calculator' })

      expect(actor.state.computerUse.grabbed()).toBeUndefined()
      expect(revoke).toHaveBeenCalledWith('use_application', 'Calculator')
      expect(emit).toHaveBeenCalledWith('s1', { type: 'computer_use_grab_changed', app: null })
      expect(await actor.inputs.computerUse.releaseGrab('s1')).toEqual({ appName: undefined })
    })

    it('a re-auth card answered with another connection releases its parked calls, or settles the card when none are parked', async () => {
      const actor = createAgentRegistry(fake.deps).get('a') as LocalAgentActor
      const parked = actor.inputs.mcpReauth.request({ mcpId: 'm1', mcpName: 'Cal', authType: 'oauth' }, { waitId: 'w1' })
      const [card] = actor.state.inputRequests.getOpenRequests()

      expect(await actor.inputs.mcpReauth.settleReplaced(card.id, 'm2')).toBe('released')
      await expect(parked).resolves.toEqual({ outcome: 'replaced', replacementId: 'm2' })

      await actor.inputs.register({ id: 'stale-card', kind: 'mcp_reauth_required', scope: {}, blocking: true, payload: {} } as never)
      expect(await actor.inputs.mcpReauth.settleReplaced('stale-card', 'm2')).toBe('resolved')
      expect((await actor.inputs.recentResolution('stale-card'))?.outcome).toBe('answered')
    })

    it('a reconnected connection resumes only this agent\'s parked calls', async () => {
      const registry = createAgentRegistry(fake.deps)
      const mine = registry.get('a').inputs.accountReauth.request({ accountId: 'acct', toolkit: 'gmail', accountStatus: 'expired' }, { waitId: 'w1' })
      void registry.get('b').inputs.accountReauth.request({ accountId: 'acct', toolkit: 'gmail', accountStatus: 'expired' }, { waitId: 'w2' })

      expect(await registry.get('a').inputs.accountReauth.completeAccount('acct')).toBe(1)
      await expect(mine).resolves.toEqual({ outcome: 'resumed' })
      expect((registry.get('b') as LocalAgentActor).state.accountReauth.openEntryIds()).toHaveLength(1)
    })

    it('deleting sessions lets go of their streams: before the one delete, after the batch for what it deleted', async () => {
      const sessionService = fake.deps.sessionService as unknown as Record<string, unknown>
      const order: string[] = []
      sessionService.deleteSession = vi.fn(async () => { order.push('delete'); return true })
      sessionService.deleteSessionsBatch = vi.fn(async () => { order.push('delete-batch'); return ['s2'] })
      const actor = createAgentRegistry(fake.deps).get('a') as LocalAgentActor
      vi.spyOn(actor.state.sessions, 'unsubscribe').mockImplementation((sessionId) => { order.push(`unsubscribe ${sessionId}`) })

      await actor.sessions.delete('s1')
      await actor.sessions.deleteMany(['s2', 's3'])

      expect(order).toEqual(['unsubscribe s1', 'delete', 'delete-batch', 'unsubscribe s2'])
    })
  })
})
