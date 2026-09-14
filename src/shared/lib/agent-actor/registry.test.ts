import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { PendingUserInputRequest, UserInputRequestOutcome } from '@shared/lib/user-input/request-schema'
import { createAgentRegistry } from './registry'
import type { LocalActorDeps } from './local-agent-actor'

// The singleton registry wires the real manager, persister, and input
// registries. These tests build their own registry from fakes, so the real
// modules are stubbed to keep the import side-effect free.
vi.mock('@shared/lib/container/container-host', () => ({ containerHost: {} }))
vi.mock('@shared/lib/container/message-persister', () => ({ messagePersister: {} }))
vi.mock('@shared/lib/user-input/request-manager', () => ({ userInputRequestManager: {} }))
vi.mock('@shared/lib/proxy/review-manager', () => ({ reviewManager: {} }))
vi.mock('@shared/lib/computer-use/permission-manager', () => ({ computerUsePermissionManager: {} }))
vi.mock('@shared/lib/proxy/mcp-reauth-manager', () => ({ mcpReauthManager: {} }))
vi.mock('@shared/lib/services/session-service', () => ({}))
vi.mock('@shared/lib/services/session-transcript-append', () => ({ appendInformationalEntry: vi.fn() }))
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

/** Enough of UserInputRequestManager to exercise the actor's ownership guard. */
function fakeInputManager() {
  const requests = new Map<string, FakeRequest>()
  const claimed = new Set<string>()
  const settled: Array<{ id: string; kind: FakeRequest['kind']; scope: FakeRequest['scope']; outcome: unknown }> = []
  return {
    requests,
    claimed,
    register: vi.fn((input: FakeRequest) => {
      requests.set(input.id, input)
      return input
    }),
    getOpenRequest: vi.fn((id: string) => requests.get(id) ?? null),
    claimRequest: vi.fn((id: string) => {
      const request = requests.get(id)
      if (!request || claimed.has(id)) return null
      claimed.add(id)
      return request
    }),
    releaseClaim: vi.fn((id: string) => {
      claimed.delete(id)
    }),
    resolve: vi.fn((id: string, outcome: unknown) => {
      const request = requests.get(id)
      if (!request) return null
      requests.delete(id)
      claimed.delete(id)
      settled.push({ id, kind: request.kind, scope: request.scope, outcome })
      return request
    }),
    getRecentResolution: vi.fn((id: string) => settled.find((entry) => entry.id === id)),
    enrichOpenRequestPayload: vi.fn((id: string, kind: FakeRequest['kind'], enrichment: Record<string, unknown>) => {
      const request = requests.get(id)
      if (!request || request.kind !== kind) return false
      Object.assign(request.payload, enrichment)
      return true
    }),
    getOpenRequestsForAgent: vi.fn((slug: string) => [...requests.values()].filter((r) => r.scope.agentSlug === slug)),
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
  }
  const reviewManager = {
    requestReview: vi.fn().mockResolvedValue('allow'),
  }
  const inputManager = fakeInputManager()
  const loadDailyUsageData = vi.fn().mockResolvedValue([])
  const loadSessionUsageTotals = vi.fn().mockResolvedValue({ totalCost: 0, totalTokens: 0, priceMissing: false })
  const syncAgentConnectionEnvironment = vi.fn().mockResolvedValue(true)
  const deps = {
    containerHost,
    messagePersister: {},
    userInputRequestManager: inputManager,
    reviewManager,
    computerUsePermissionManager: {},
    mcpReauthManager: {},
    sessionService: {},
    appendInformationalEntry: vi.fn(),
    getAgentWorkspaceDir: vi.fn((slug: string) => `/workspaces/${slug}`),
    getAgentClaudeConfigDir: vi.fn((slug: string) => `/workspaces/${slug}/.claude`),
    getSessionJsonlPath: vi.fn((slug: string, sessionId: string) => `/workspaces/${slug}/sessions/${sessionId}.jsonl`),
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
  }
}

const outcome = { kind: 'settled' } as unknown as UserInputRequestOutcome

describe('createAgentRegistry', () => {
  let fake: ReturnType<typeof fakeDeps>

  beforeEach(() => {
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
      await actor.messages.send('s1', 'hi', 'u1', { isAutomated: true })
      expect(fake.containerHost.runtime).toHaveBeenCalledWith('a')
      expect(fake.runtimes.get('a')?.getClient).toHaveBeenCalledTimes(1)
      expect(fake.client.sendMessage).toHaveBeenCalledWith('s1', 'hi', 'u1', { isAutomated: true })
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

    it('usage.daily reads this agent\'s Claude data directory', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      await actor.usage.daily({ since: '2026-09-01', providerId: 'anthropic' })
      expect(fake.loadDailyUsageData).toHaveBeenCalledWith({
        claudePath: '/workspaces/a/.claude',
        since: '2026-09-01',
        providerId: 'anthropic',
      })
    })

    it('sessions.usage reads this session\'s transcript', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      await actor.sessions.usage('s1', { providerId: 'anthropic' })
      expect(fake.loadSessionUsageTotals).toHaveBeenCalledWith({
        sessionPath: '/workspaces/a/sessions/s1.jsonl',
        providerId: 'anthropic',
      })
    })

    it('inputs.reviews.request stamps the actor\'s slug onto the review', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      const details = {
        accountId: 'acct',
        toolkit: 'gmail',
        method: 'GET',
        targetPath: '/messages',
        matchedScopes: ['read'],
        scopeDescriptions: {},
      }
      await expect(actor.inputs.reviews.request(details)).resolves.toBe('allow')
      // Only the arguments given are forwarded — no trailing `undefined` for an omitted signal.
      expect(fake.reviewManager.requestReview).toHaveBeenCalledWith({ ...details, agentSlug: 'a' })
    })

    it('files.workspacePath resolves the agent workspace by slug', () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      expect(actor.files.workspacePath()).toBe('/workspaces/a')
    })
  })

  describe('inputs are scoped to the handle\'s agent', () => {
    const request = (id: string, agentSlug: string): FakeRequest => ({
      id,
      kind: 'question' as PendingUserInputRequest['kind'],
      scope: { agentSlug, sessionId: 's' },
      payload: {},
    })

    it('register stamps this agent onto the scope, whatever the caller wrote', () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      actor.inputs.register(request('r1', 'b') as never)
      expect(fake.inputManager.register).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'r1', scope: { agentSlug: 'a', sessionId: 's' } }),
      )
    })

    it('another agent\'s request is not found: get, claim, enrich and resolve miss and leave it untouched', () => {
      const registry = createAgentRegistry(fake.deps)
      fake.inputManager.requests.set('rb', request('rb', 'b'))
      const a = registry.get('a').inputs

      expect(a.get('rb')).toBeNull()
      expect(a.claim('rb')).toBeNull()
      expect(a.enrich('rb', 'question' as PendingUserInputRequest['kind'], { note: 1 })).toBe(false)
      expect(a.resolve('rb', outcome)).toBeNull()

      expect(fake.inputManager.claimRequest).not.toHaveBeenCalled()
      expect(fake.inputManager.enrichOpenRequestPayload).not.toHaveBeenCalled()
      expect(fake.inputManager.resolve).not.toHaveBeenCalled()
      expect(fake.inputManager.requests.get('rb')).toEqual(request('rb', 'b'))
    })

    it('the owning agent can still see, claim, settle and read back its own request', () => {
      const registry = createAgentRegistry(fake.deps)
      fake.inputManager.requests.set('rb', request('rb', 'b'))
      const b = registry.get('b').inputs

      expect(b.get('rb')?.id).toBe('rb')
      expect(b.claim('rb')?.id).toBe('rb')
      expect(b.enrich('rb', 'question' as PendingUserInputRequest['kind'], { note: 1 })).toBe(true)
      expect(b.resolve('rb', outcome)?.id).toBe('rb')
      expect(b.recentResolution('rb')?.id).toBe('rb')
      // The settled record is scoped too: another agent cannot read it back.
      expect(registry.get('a').inputs.recentResolution('rb')).toBeUndefined()
    })

    it('releaseClaim only drops a claim this agent could have taken', () => {
      const registry = createAgentRegistry(fake.deps)
      fake.inputManager.requests.set('rb', request('rb', 'b'))
      expect(registry.get('b').inputs.claim('rb')?.id).toBe('rb')

      registry.get('a').inputs.releaseClaim('rb')
      expect(fake.inputManager.claimed.has('rb')).toBe(true)

      registry.get('b').inputs.releaseClaim('rb')
      expect(fake.inputManager.claimed.has('rb')).toBe(false)
    })
  })
})
