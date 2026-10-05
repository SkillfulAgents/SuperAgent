import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { PendingUserInputRequest, UserInputRequestOutcome } from '@shared/lib/user-input/request-schema'
import { getSessionSummaryCacheSlot } from '@shared/lib/services/session-summary-cache'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import { ReviewManager } from '@shared/lib/proxy/review-manager'
import { AccountReauthManager } from '@shared/lib/proxy/account-reauth-manager'
import { McpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import { ComputerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import { createAgentRegistry } from './registry'
import type { AgentState } from './agent-state'
import type { LocalActorDeps, LocalAgentActor } from './local-agent-actor'

// The singleton registry wires the real host and persister. These tests build
// their own registry from fakes, so those modules are stubbed to keep the
// import side-effect free. The per-agent stores (input requests, reviews,
// re-auth waits, computer-use grants) and the routers over them are real:
// they are the actor's own and are what the tests below exercise.
vi.mock('@shared/lib/container/container-host', () => ({ containerHost: { attachAgentWorkspaces: () => {} } }))
vi.mock('@shared/lib/container/message-persister', () => ({ messagePersister: { attachSessionStores: () => {} } }))
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
vi.mock('ws', () => ({ WebSocket: vi.fn() }))

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
  const messagePersister = {
    attachSessionStores: vi.fn(),
    markSessionIdle: vi.fn(),
    syncAgentSessionsAwaiting: vi.fn(),
  }
  const deps = {
    containerHost,
    messagePersister,
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
    messagePersister,
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
    vi.mocked(WebSocket).mockClear()
  })

  it('returns one stable handle per slug, created on first get', () => {
    const registry = createAgentRegistry(fake.deps)
    expect(registry.peek('a')).toBeUndefined()

    const a = registry.get('a')
    expect(a.slug).toBe('a')
    expect(registry.get('a')).toBe(a)
    expect(registry.peek('a')).toBe(a)
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

  it('evict drops the handle and forgets the runtime for that slug only', () => {
    const registry = createAgentRegistry(fake.deps)
    const a = registry.get('a')
    const b = registry.get('b')

    registry.evict('a')

    expect(fake.containerHost.dropRuntime).toHaveBeenCalledWith('a')
    expect(registry.peek('a')).toBeUndefined()
    expect(registry.peek('b')).toBe(b)
    expect(registry.get('a')).not.toBe(a)
  })

  it('evictAll clears every handle and every runtime', () => {
    const registry = createAgentRegistry(fake.deps)
    registry.get('a')
    registry.get('b')

    registry.evictAll()

    expect(fake.containerHost.clearRuntimes).toHaveBeenCalledTimes(1)
    expect(registry.peek('a')).toBeUndefined()
    expect(registry.peek('b')).toBeUndefined()
  })

  it('running() is the agents whose container is up, reusing handles already handed out', () => {
    const registry = createAgentRegistry(fake.deps)
    const a = registry.get('a')
    fake.containerHost.getRunningAgentIds.mockReturnValue(['a', 'c'])

    const running = registry.running()

    expect(running.map((actor) => actor.slug)).toEqual(['a', 'c'])
    expect(running[0]).toBe(a)
    expect(registry.peek('c')).toBe(running[1])
  })

  describe('passthroughs reach this agent\'s runtime and keep the client inside', () => {
    it('container.start resolves to nothing even though ensureRunning returns the client', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      await expect(actor.container.start()).resolves.toBeUndefined()
      expect(fake.containerHost.runtime).toHaveBeenCalledWith('a')
      expect(fake.runtimes.get('a')?.ensureRunning).toHaveBeenCalledTimes(1)
    })

    it('messages.send goes to this agent\'s client', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      await actor.messages.send('s1', 'hi', 'u1', { noninteractive: true })
      expect(fake.containerHost.runtime).toHaveBeenCalledWith('a')
      expect(fake.runtimes.get('a')?.getClient).toHaveBeenCalledTimes(1)
      expect(fake.client.sendMessage).toHaveBeenCalledWith('s1', 'hi', 'u1', { noninteractive: true })
    })

    it('sessions.broadcastUpdate and syncAwaiting reach the persister scoped to this agent', () => {
      const broadcastSessionUpdate = vi.fn()
      const syncAgentSessionsAwaiting = vi.fn()
      const deps = {
        ...fake.deps,
        messagePersister: { attachSessionStores: vi.fn(), broadcastSessionUpdate, syncAgentSessionsAwaiting },
      } as unknown as LocalActorDeps
      const actor = createAgentRegistry(deps).get('a')
      actor.sessions.broadcastUpdate('s1')
      actor.sessions.syncAwaiting()
      expect(broadcastSessionUpdate).toHaveBeenCalledWith('a', 's1')
      expect(syncAgentSessionsAwaiting).toHaveBeenCalledWith('a')
    })

    it('container.openWebSocket targets this agent\'s container and adds its auth headers last', () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      expect(fake.containerHost.runtime).not.toHaveBeenCalled()

      actor.container.openWebSocket('/browser/stream', {
        search: '?since=1',
        protocols: ['p1'],
        headers: { 'x-forwarded': 'yes', 'x-host': 'spoofed' },
      })

      expect(fake.runtimes.get('a')?.getCachedInfo).toHaveBeenCalledTimes(1)
      expect(fake.client.getWebSocketBaseUrl).toHaveBeenCalledWith(4321)
      expect(vi.mocked(WebSocket)).toHaveBeenCalledWith('ws://127.0.0.1:4321/browser/stream?since=1', ['p1'], {
        headers: { 'x-forwarded': 'yes', 'x-host': '1' },
      })
    })

    it('container.openWebSocket refuses while the container is not running', () => {
      fake.containerHost.runtime('a').getCachedInfo.mockReturnValue({ status: 'stopped', port: null })
      const actor = createAgentRegistry(fake.deps).get('a')
      expect(() => actor.container.openWebSocket('/browser/stream')).toThrow(/not running/)
      expect(vi.mocked(WebSocket)).not.toHaveBeenCalled()
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

    it('hands the persister this agent\'s session store, the one its own reads use', () => {
      const registry = createAgentRegistry(fake.deps)
      const attach = (fake.deps.messagePersister as unknown as { attachSessionStores: ReturnType<typeof vi.fn> }).attachSessionStores
      // On the first handle, once: the persister is not initialized while the registry module evaluates.
      expect(attach).not.toHaveBeenCalled()
      const actor = registry.get('a')
      registry.get('b')
      expect(attach).toHaveBeenCalledTimes(1)
      const resolve = attach.mock.calls[0]![0] as (slug: string) => { slug: string; files: unknown; transcriptsDir: string }
      const store = resolve('a')
      expect(store.slug).toBe('a')
      expect(store.files).toBe(actor.files)
      expect(store.transcriptsDir).toBe('.claude/projects/-workspace')
    })

    it('inputs.reviews.request parks the review on the actor\'s own store under its slug', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      const details = {
        accountId: 'acct',
        toolkit: 'gmail',
        method: 'GET',
        targetPath: '/messages',
        matchedScopes: ['read'],
        scopeDescriptions: {},
      }
      const decision = actor.inputs.reviews.request(details)
      const [open] = actor.inputs.openForAgent()
      expect(open).toMatchObject({ kind: 'proxy_review', scope: { agentSlug: 'a' }, payload: { ...details, agentSlug: 'a' } })
      expect(actor.inputs.reviews.pending().map((r) => r.id)).toEqual([open.id])
      // The transition reached the router, which is how the wire hears of it.
      expect(fake.inputManager.report).toHaveBeenCalledWith(expect.objectContaining({ type: 'created', request: open }))
      expect(actor.inputs.reviews.submit(open.id, 'allow')).toBe(true)
      await expect(decision).resolves.toBe('allow')
      expect(fake.messagePersister.syncAgentSessionsAwaiting).toHaveBeenCalledWith('a')
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
      actor.sessions.recordActivity('s1')
      expect(fake.recordSessionActivity).toHaveBeenCalledWith(store, 's1')
      actor.sessions.recordActivity('s1', 1234)
      expect(fake.recordSessionActivity).toHaveBeenCalledWith(store, 's1', 1234)
    })
  })

  describe('container.idleSince is the actor\'s own clock', () => {
    it('is answered by this agent\'s runtime', () => {
      fake.containerHost.runtime('a').idleSince.mockReturnValue(1_000)
      const registry = createAgentRegistry(fake.deps)
      expect(registry.get('a').container.idleSince()).toBe(1_000)
      expect(registry.get('b').container.idleSince()).toBeNull()
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

    it('sessions.markIdle marks the runtime before the session goes idle', () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      actor.sessions.markIdle('s1')
      expect(fake.runtimes.get('a')?.noteSessionActivity).toHaveBeenCalledTimes(1)
      expect(fake.messagePersister.markSessionIdle).toHaveBeenCalledWith('a', 's1')
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

    it('register stamps this agent onto the scope, whatever the caller wrote, and reports the transition', () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      const stored = actor.inputs.register({ ...request('r1', 'b'), blocking: true } as never)
      expect(stored).toMatchObject({ id: 'r1', scope: { agentSlug: 'a', sessionId: 's' } })
      expect(actor.inputs.open('s').map((r) => r.id)).toEqual(['r1'])
      expect(fake.inputManager.report).toHaveBeenCalledWith({ type: 'created', request: stored })
    })

    it('another agent\'s request is not found: get, claim, enrich and resolve miss and leave it untouched', () => {
      const registry = createAgentRegistry(fake.deps)
      const stored = register(registry, 'b', 'rb')
      const a = registry.get('a').inputs

      expect(a.get('rb')).toBeNull()
      expect(a.claim('rb')).toBeNull()
      expect(a.enrich('rb', 'question' as PendingUserInputRequest['kind'], { note: 1 })).toBe(false)
      expect(a.resolve('rb', outcome)).toBeNull()
      expect(a.snapshot()).toEqual([])

      expect(registry.get('b').inputs.get('rb')).toBe(stored)
      expect(stored!.payload).toEqual({})
    })

    it('the owning agent can still see, claim, settle and read back its own request', () => {
      const registry = createAgentRegistry(fake.deps)
      register(registry, 'b', 'rb')
      const b = registry.get('b').inputs

      expect(b.get('rb')?.id).toBe('rb')
      expect(b.claim('rb')?.id).toBe('rb')
      expect(b.enrich('rb', 'question' as PendingUserInputRequest['kind'], { note: 1 })).toBe(true)
      expect(b.resolve('rb', outcome)?.id).toBe('rb')
      expect(b.recentResolution('rb')?.id).toBe('rb')
      // The settled record is the owner's too: another agent cannot read it back.
      expect(registry.get('a').inputs.recentResolution('rb')).toBeUndefined()
    })

    it('releaseClaim only drops a claim this agent could have taken', () => {
      const registry = createAgentRegistry(fake.deps)
      register(registry, 'b', 'rb')
      expect(registry.get('b').inputs.claim('rb')?.id).toBe('rb')

      registry.get('a').inputs.releaseClaim('rb')
      expect(registry.get('b').inputs.claim('rb')).toBeNull()

      registry.get('b').inputs.releaseClaim('rb')
      expect(registry.get('b').inputs.claim('rb')?.id).toBe('rb')
    })
  })

  describe('the registry attaches the routers to the handles\' stores', () => {
    it('gives every router a directory that reads through the handles and creates none of its own', () => {
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
      // A router creating the first handle is a first use: the persister gets its stores then.
      expect(fake.messagePersister.attachSessionStores).not.toHaveBeenCalled()
      const store = directory.get('a')
      expect(fake.messagePersister.attachSessionStores).toHaveBeenCalledTimes(1)
      expect(store).toBe((registry.get('a') as LocalAgentActor).state.inputRequests)
      expect(directory.peek('a')).toBe(store)
      expect(directory.all()).toEqual([store])
      registry.evict('a')
      expect(directory.all()).toEqual([])
    })
  })

  describe('a registry built over an earlier registry\'s state (a dev-server reload)', () => {
    it('wraps every surviving state in a fresh handle, visible to the routers at once', () => {
      const states = new Map<string, AgentState>()
      const before = createAgentRegistry(fake.deps, { states })
      const actor = before.get('a') as LocalAgentActor
      actor.inputs.register({ id: 'q1', kind: 'question', scope: { sessionId: 's' }, blocking: true, payload: {} } as never)
      expect(states.get('a')).toBe(actor.state)

      const after = createAgentRegistry(fake.deps, { states })
      const rebuilt = after.get('a') as LocalAgentActor
      expect(rebuilt).not.toBe(actor)
      expect(rebuilt.state).toBe(actor.state)
      expect(rebuilt.inputs.get('q1')?.id).toBe('q1')
      // The new registry's directory sees the rebuilt handle without a `get`:
      // the last attach is the new registry's.
      const directory = fake.inputManager.attachAgents.mock.calls.at(-1)![0] as { all: () => unknown[] }
      expect(directory.all()).toEqual([rebuilt.state.inputRequests])

      after.evict('a')
      expect(states.has('a')).toBe(false)
      expect(after.get('a').inputs.get('q1')).toBeNull()
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
      actor.inputs.register({ id: 'q1', kind: 'question', scope: { sessionId: 's' }, blocking: true, payload: {} } as never)
      const review = actor.inputs.reviews.request(reviewDetails)
      const account = actor.inputs.accountReauth.request({ accountId: 'acct', toolkit: 'gmail', accountStatus: 'expired' })
      const mcp = actor.inputs.mcpReauth.request({ mcpId: 'm1', mcpName: 'Cal', authType: 'oauth' })
      actor.inputs.computerUse.grant('use_host_shell', 'once')
      actor.inputs.computerUse.setGrabbedApp('Calculator')
      getSessionSummaryCacheSlot(actor.store).revision = 7
      expect(actor.inputs.openForAgent()).toHaveLength(4)
      fake.inputManager.report.mockClear()

      registry.evict('a')

      await expect(review).rejects.toThrow('Review timeout')
      await expect(account).rejects.toThrow(/no longer held by this process/)
      await expect(mcp).rejects.toThrow(/no longer held by this process/)
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
      expect(fake.messagePersister.syncAgentSessionsAwaiting).toHaveBeenCalledWith('a')
      expect(fake.containerHost.dropRuntime).toHaveBeenCalledWith('a')

      // Nothing survives into the next handle for the slug.
      const fresh = registry.get('a') as LocalAgentActor
      expect(fresh).not.toBe(actor)
      expect(fresh.inputs.openForAgent()).toEqual([])
      expect(fresh.inputs.reviews.pending()).toEqual([])
      expect(fresh.inputs.recentResolution('q1')).toBeUndefined()
      expect(fresh.inputs.computerUse.grabbedApp()).toBeUndefined()
      expect(fresh.state.computerUse.activeGrants()).toEqual([])
      expect(fresh.state.accountReauth.openEntryIds()).toEqual([])
      expect(fresh.state.mcpReauth.openEntryIds()).toEqual([])
      expect(getSessionSummaryCacheSlot(fresh.store).revision).toBe(0)
      // And the old handle holds nothing either.
      expect(actor.inputs.openForAgent()).toEqual([])
      expect(actor.state.reviews.settlerIds()).toEqual([])
    })

    it('evictAll evicts every handle the same way', async () => {
      const registry = createAgentRegistry(fake.deps)
      const a = registry.get('a')
      const b = registry.get('b')
      const reviewA = a.inputs.reviews.request(reviewDetails)
      const reviewB = b.inputs.reviews.request(reviewDetails)

      registry.evictAll()

      await expect(reviewA).rejects.toThrow('Review timeout')
      await expect(reviewB).rejects.toThrow('Review timeout')
      // The host forgets the runtimes its own way (a starting one is kept).
      expect(fake.containerHost.dropRuntime).not.toHaveBeenCalled()
      expect(fake.containerHost.clearRuntimes).toHaveBeenCalledTimes(1)
      expect(registry.peek('a')).toBeUndefined()
      expect(registry.peek('b')).toBeUndefined()
    })
  })
})
