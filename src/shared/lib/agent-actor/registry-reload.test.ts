/**
 * In development the backend modules are re-evaluated on edit (the Vite
 * adapter reloads the SSR entry in the same process). The host, the persister
 * and the routers survive that on `globalThis`; the state the actors own must
 * survive with them, or every parked approval and reconnect wait is stranded
 * until it times out. These drive a real module reload with `vi.resetModules`
 * and check that the reloaded registry still finds and settles what the
 * previous one held.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/container/container-host', () => ({
  containerHost: { attachAgentWorkspaces: vi.fn(), dropRuntime: vi.fn(), clearRuntimes: vi.fn() },
}))
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: { attachSessionStores: vi.fn(), syncAgentSessionsAwaiting: vi.fn() },
}))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: () => ({}), mutateSettings: vi.fn() }))
vi.mock('@shared/lib/services/session-service', () => ({}))
vi.mock('@shared/lib/services/session-transcript-append', () => ({
  appendInformationalEntry: vi.fn(),
  appendAssistantEntry: vi.fn(),
}))
vi.mock('@shared/lib/agent-actor/local-transcript-ops', () => ({}))
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentWorkspaceDir: (slug: string) => `/nonexistent/registry-reload/${slug}`,
}))
vi.mock('@shared/lib/container/connection-runtime-sync', () => ({}))
vi.mock('@shared/lib/services/usage-service', () => ({}))

const registries: Array<{ evictAll(): void }> = []

/** The backend as one module evaluation sees it. */
async function load() {
  const { agentRegistry } = await import('./registry')
  const { userInputRequestManager } = await import('@shared/lib/user-input/request-manager')
  const { reviewManager } = await import('@shared/lib/proxy/review-manager')
  const { accountReauthManager } = await import('@shared/lib/proxy/account-reauth-manager')
  registries.push(agentRegistry)
  return { agentRegistry, userInputRequestManager, reviewManager, accountReauthManager }
}

/** The reload: every module is evaluated again; what lives on globalThis carries over. */
async function reload() {
  vi.resetModules()
  return load()
}

afterEach(async () => {
  const managers = await load()
  for (const registry of registries.splice(0)) registry.evictAll()
  managers.reviewManager.rejectAll()
  managers.accountReauthManager.rejectAll()
  managers.userInputRequestManager.reset()
})

const reviewDetails = {
  accountId: 'acct',
  toolkit: 'gmail',
  method: 'GET',
  targetPath: '/messages',
  matchedScopes: ['read'],
  scopeDescriptions: {},
}

describe('the actors\' state survives a backend module reload', () => {
  it('a pending input registered before the reload is still open after it', async () => {
    const original = await load()
    original.agentRegistry.get('a').inputs.register({
      id: 'reload-secret',
      kind: 'secret',
      scope: { sessionId: 's' },
      blocking: true,
      payload: {},
    })

    const reloaded = await reload()

    // The routers carried over on globalThis; the registry is a new object
    // wrapping the same state.
    expect(reloaded.userInputRequestManager).toBe(original.userInputRequestManager)
    expect(reloaded.agentRegistry).not.toBe(original.agentRegistry)
    expect(reloaded.agentRegistry.get('a').inputs.get('reload-secret')).not.toBeNull()
    expect(reloaded.userInputRequestManager.getOpenRequest('reload-secret', 'a')?.id).toBe('reload-secret')
    // The router's id index was rebuilt from the surviving stores: a bare id
    // still finds its owner, and the owner is not announced a second time.
    expect(reloaded.userInputRequestManager.getOpenRequest('reload-secret')?.scope.agentSlug).toBe('a')
    // Visible to sweeps without anyone asking for the handle first.
    expect(reloaded.userInputRequestManager.getOpenRequestsForAgent('a').map((r) => r.id)).toEqual(['reload-secret'])
  })

  it('a bare id shared by two agents still goes to the agent that registered it first after the reload', async () => {
    const original = await load()
    // a's handle exists first; b registers the shared id first.
    original.agentRegistry.get('a')
    original.agentRegistry.get('b').inputs.register({
      id: 'shared-id',
      kind: 'secret',
      scope: { sessionId: 's' },
      blocking: true,
      payload: {},
    })
    original.agentRegistry.get('a').inputs.register({
      id: 'shared-id',
      kind: 'secret',
      scope: { sessionId: 's' },
      blocking: true,
      payload: {},
    })
    expect(original.userInputRequestManager.getOpenRequest('shared-id')?.scope.agentSlug).toBe('b')

    const reloaded = await reload()

    expect(reloaded.userInputRequestManager.getOpenRequest('shared-id')?.scope.agentSlug).toBe('b')
    expect(reloaded.userInputRequestManager.resolve('shared-id', 'answered')?.scope.agentSlug).toBe('b')
    expect(reloaded.userInputRequestManager.getOpenRequest('shared-id')?.scope.agentSlug).toBe('a')
  })

  it('a review parked before the reload is decidable after it, by the actor and by bare id, and the parked call resumes', async () => {
    const original = await load()
    const decision = original.agentRegistry
      .get('a')
      .inputs.reviews.request(reviewDetails)
      .catch(() => 'rejected')
    const bare = original.agentRegistry
      .get('b')
      .inputs.reviews.request(reviewDetails)
      .catch(() => 'rejected')
    const [entry] = original.agentRegistry.get('a').inputs.reviews.pending()
    const [bareEntry] = original.agentRegistry.get('b').inputs.reviews.pending()

    const reloaded = await reload()

    expect(reloaded.agentRegistry.get('a').inputs.reviews.pending().map((r) => r.id)).toEqual([entry.id])
    expect(reloaded.agentRegistry.get('a').inputs.reviews.submit(entry.id, 'allow')).toBe(true)
    await expect(decision).resolves.toBe('allow')
    // The id-only decision path finds the owner through the rebuilt index.
    expect(reloaded.reviewManager.submitDecision(bareEntry.id, 'allow')).toBe(true)
    await expect(bare).resolves.toBe('allow')
  })

  it('a reconnect completed after the reload releases the request parked before it', async () => {
    const original = await load()
    const parked = original.accountReauthManager
      .requestReauth({ agentSlug: 'a', accountId: 'acct', toolkit: 'gmail', accountStatus: 'expired' })
      .catch(() => 'rejected')

    const reloaded = await reload()

    expect(reloaded.accountReauthManager.completeAccount('acct')).toBe(1)
    await expect(parked).resolves.toBeUndefined()
  })

  it('evicting after the reload releases the state the earlier registry built', async () => {
    const original = await load()
    const decision = original.agentRegistry
      .get('a')
      .inputs.reviews.request(reviewDetails)
      .catch((error: Error) => error.message)

    const reloaded = await reload()
    reloaded.agentRegistry.evict('a')

    await expect(decision).resolves.toBe('Review timeout')
    expect(reloaded.agentRegistry.get('a').inputs.reviews.pending()).toEqual([])
    expect(reloaded.userInputRequestManager.getOpenRequestsForAgent('a')).toEqual([])
  })
})
