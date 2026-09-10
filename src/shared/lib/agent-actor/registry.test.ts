import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentRegistry } from './registry'
import type { LocalActorDeps } from './local-agent-actor'

// The singleton registry wires the real manager, persister, and input
// registries. These tests build their own registry from fakes, so the real
// modules are stubbed to keep the import side-effect free.
vi.mock('@shared/lib/container/container-manager', () => ({ containerManager: {} }))
vi.mock('@shared/lib/container/message-persister', () => ({ messagePersister: {} }))
vi.mock('@shared/lib/user-input/request-manager', () => ({ userInputRequestManager: {} }))
vi.mock('@shared/lib/proxy/review-manager', () => ({ reviewManager: {} }))
vi.mock('@shared/lib/computer-use/permission-manager', () => ({ computerUsePermissionManager: {} }))
vi.mock('@shared/lib/proxy/mcp-reauth-manager', () => ({ mcpReauthManager: {} }))
vi.mock('@shared/lib/services/session-service', () => ({}))
vi.mock('@shared/lib/services/session-transcript-append', () => ({ appendInformationalEntry: vi.fn() }))
vi.mock('@shared/lib/utils/file-storage', () => ({ getAgentWorkspaceDir: vi.fn() }))

function fakeDeps() {
  const client = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getHostAuthHeaders: vi.fn().mockReturnValue({ 'x-host': '1' }),
  }
  const containerManager = {
    getClient: vi.fn().mockReturnValue(client),
    ensureRunning: vi.fn().mockResolvedValue(client),
    getRunningAgentIds: vi.fn().mockReturnValue([]),
    removeClient: vi.fn(),
    clearClients: vi.fn(),
  }
  const reviewManager = {
    requestReview: vi.fn().mockResolvedValue('allow'),
  }
  const deps = {
    containerManager,
    messagePersister: {},
    userInputRequestManager: {},
    reviewManager,
    computerUsePermissionManager: {},
    mcpReauthManager: {},
    sessionService: {},
    appendInformationalEntry: vi.fn(),
    getAgentWorkspaceDir: vi.fn((slug: string) => `/workspaces/${slug}`),
  }
  return { deps: deps as unknown as LocalActorDeps, containerManager, client, reviewManager }
}

describe('createAgentRegistry', () => {
  let fake: ReturnType<typeof fakeDeps>

  beforeEach(() => {
    fake = fakeDeps()
  })

  it('returns one stable handle per slug, created on first get', () => {
    const registry = createAgentRegistry(fake.deps)
    expect(registry.peek('a')).toBeUndefined()

    const a = registry.get('a')
    expect(a.slug).toBe('a')
    expect(registry.get('a')).toBe(a)
    expect(registry.peek('a')).toBe(a)
    expect(registry.get('b')).not.toBe(a)
    expect(fake.containerManager.getClient).not.toHaveBeenCalled()
  })

  it('evict drops the handle and the container client for that slug only', () => {
    const registry = createAgentRegistry(fake.deps)
    const a = registry.get('a')
    const b = registry.get('b')

    registry.evict('a')

    expect(fake.containerManager.removeClient).toHaveBeenCalledWith('a')
    expect(registry.peek('a')).toBeUndefined()
    expect(registry.peek('b')).toBe(b)
    expect(registry.get('a')).not.toBe(a)
  })

  it('evictAll clears every handle and every client', () => {
    const registry = createAgentRegistry(fake.deps)
    registry.get('a')
    registry.get('b')

    registry.evictAll()

    expect(fake.containerManager.clearClients).toHaveBeenCalledTimes(1)
    expect(registry.peek('a')).toBeUndefined()
    expect(registry.peek('b')).toBeUndefined()
  })

  it('all() is the running agents, reusing handles already handed out', () => {
    const registry = createAgentRegistry(fake.deps)
    const a = registry.get('a')
    fake.containerManager.getRunningAgentIds.mockReturnValue(['a', 'c'])

    const all = registry.all()

    expect(all.map((actor) => actor.slug)).toEqual(['a', 'c'])
    expect(all[0]).toBe(a)
    expect(registry.peek('c')).toBe(all[1])
  })

  describe('passthroughs supply the slug and keep the client inside', () => {
    it('container.start resolves to nothing even though ensureRunning returns the client', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      await expect(actor.container.start()).resolves.toBeUndefined()
      expect(fake.containerManager.ensureRunning).toHaveBeenCalledWith('a')
    })

    it('messages.send goes to this agent\'s client', async () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      await actor.messages.send('s1', 'hi', 'u1', { isAutomated: true })
      expect(fake.containerManager.getClient).toHaveBeenCalledWith('a')
      expect(fake.client.sendMessage).toHaveBeenCalledWith('s1', 'hi', 'u1', { isAutomated: true })
    })

    it('container.hostAuthHeaders reads the client at call time, not at construction', () => {
      const actor = createAgentRegistry(fake.deps).get('a')
      expect(fake.containerManager.getClient).not.toHaveBeenCalled()
      expect(actor.container.hostAuthHeaders()).toEqual({ 'x-host': '1' })
      expect(fake.containerManager.getClient).toHaveBeenCalledWith('a')
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
})
