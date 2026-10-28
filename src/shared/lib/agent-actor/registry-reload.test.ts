/**
 * In development the backend modules are re-evaluated on edit (the Vite
 * adapter reloads the SSR entry in the same process). The host and the routers
 * survive that on `globalThis`; the state the actors own (their live sessions
 * among it) must survive with them, or every parked approval and reconnect
 * wait is stranded until it times out. These drive a real module reload with
 * `vi.resetModules` and check that the reloaded registry still finds and
 * settles what the previous one held.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionsAccess } from '@shared/lib/container/agent-sessions-access'
import type { LocalAgentActor } from './local-agent-actor'
import { drain, drained } from './testing/drain'

vi.mock('@shared/lib/container/container-host', () => ({
  containerHost: { attachAgentWorkspaces: vi.fn(), attachAgentSessions: vi.fn(), dropRuntime: vi.fn(), clearRuntimes: vi.fn() },
}))
// What the agents' live sessions hand the host (feed events, notifications)
// is not what these tests are about: a recording port keeps it in the test.
vi.mock('@shared/lib/host/local-host-port', async () => ({
  localHostPort: (await import('./testing/recording-host-port')).createRecordingHostPort().port,
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
  const { userInputRequestManager } = await import('@shared/lib/tools/requests/request-manager')
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

/** The agent's pending reviews, once `count` have reached it: a parked request is never awaited, so wait for it to arrive. */
async function parked(managers: { reviewManager: { getPendingReviewsForAgent(slug: string): Array<{ id: string }> } }, slug: string, count = 1) {
  await vi.waitFor(() => expect(managers.reviewManager.getPendingReviewsForAgent(slug)).toHaveLength(count))
  return managers.reviewManager.getPendingReviewsForAgent(slug)
}

afterEach(async () => {
  const managers = await load()
  for (const registry of registries.splice(0)) registry.evictAll()
  await managers.agentRegistry.evictAll()
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
    await original.agentRegistry.get('a').inputs.register({
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
    expect(await reloaded.agentRegistry.get('a').inputs.get('reload-secret')).not.toBeNull()
    expect(reloaded.userInputRequestManager.getOpenRequest('a', 'reload-secret')?.id).toBe('reload-secret')
    // Visible to sweeps without anyone asking for the handle first.
    expect(reloaded.userInputRequestManager.getOpenRequestsForAgent('a').map((r) => r.id)).toEqual(['reload-secret'])
  })

  it('the live sessions held before the reload are the ones after it, and the container host reaches them', async () => {
    const original = await load()
    const heard: unknown[] = []
    drain(await original.agentRegistry.get('a').messages.subscribe('s'), (event) => heard.push(event))
    const sessions = (original.agentRegistry.get('a') as LocalAgentActor).state.sessions

    const reloaded = await reload()

    expect((reloaded.agentRegistry.get('a') as LocalAgentActor).state.sessions).toBe(sessions)
    // A tab listening before the reload hears what the reloaded code emits.
    await reloaded.agentRegistry.get('a').sessions.broadcastUpdate('s')
    await drained()
    expect(heard).toEqual([{ type: 'session_updated' }])
    // The reloaded registry attached the reloaded host to the same sessions.
    const { containerHost } = await import('@shared/lib/container/container-host')
    const access = vi.mocked(containerHost.attachAgentSessions).mock.calls.at(-1)![0] as AgentSessionsAccess
    expect(access.peek('a')).toBe(sessions)
  })

  it('an id open in two agents is answered by the agent the router names, before and after the reload', async () => {
    const original = await load()
    // a's handle exists first; b registers the shared id first.
    original.agentRegistry.get('a')
    await original.agentRegistry.get('b').inputs.register({
      id: 'shared-id',
      kind: 'secret',
      scope: { sessionId: 's' },
      blocking: true,
      payload: {},
    })
    await original.agentRegistry.get('a').inputs.register({
      id: 'shared-id',
      kind: 'secret',
      scope: { sessionId: 's' },
      blocking: true,
      payload: {},
    })
    expect(original.userInputRequestManager.getOpenRequest('b', 'shared-id')?.scope.agentSlug).toBe('b')

    const reloaded = await reload()

    expect(reloaded.userInputRequestManager.getOpenRequest('b', 'shared-id')?.scope.agentSlug).toBe('b')
    expect(reloaded.userInputRequestManager.resolve('b', 'shared-id', 'answered')?.scope.agentSlug).toBe('b')
    expect(reloaded.userInputRequestManager.getOpenRequest('b', 'shared-id')).toBeNull()
    expect(reloaded.userInputRequestManager.getOpenRequest('a', 'shared-id')?.scope.agentSlug).toBe('a')
  })

  it('a review parked before the reload is decidable after it, by the actor and by the router, and the parked call resumes', async () => {
    const original = await load()
    const decision = original.agentRegistry
      .get('a')
      .inputs.reviews.request(reviewDetails, { id: 'review-a' })
    const bare = original.agentRegistry
      .get('b')
      .inputs.reviews.request(reviewDetails, { id: 'review-b' })
    const [entry] = await parked(original, 'a')
    const [bareEntry] = await parked(original, 'b')

    const reloaded = await reload()

    expect((await reloaded.agentRegistry.get('a').inputs.reviews.get(entry.id))?.id).toBe(entry.id)
    expect(await reloaded.agentRegistry.get('a').inputs.reviews.submit(entry.id, 'allow')).toBe(true)
    await expect(decision).resolves.toBe('allow')
    // The router reaches the surviving store through the reloaded registry.
    expect(reloaded.reviewManager.submitDecision('b', bareEntry.id, 'allow')).toBe(true)
    await expect(bare).resolves.toBe('allow')
  })

  it('a reconnect completed after the reload releases the request parked before it', async () => {
    const original = await load()
    const parked = original.accountReauthManager
      .requestReauth({ agentSlug: 'a', accountId: 'acct', toolkit: 'gmail', accountStatus: 'expired' })

    const reloaded = await reload()

    expect(await reloaded.agentRegistry.get('a').inputs.accountReauth.completeAccount('acct')).toBe(1)
    await expect(parked).resolves.toEqual({ outcome: 'resumed' })
  })

  it('the reloaded handle reads the session store the live sessions write to', async () => {
    const original = await load()
    const before = original.agentRegistry.get('a') as LocalAgentActor

    const reloaded = await reload()
    const after = reloaded.agentRegistry.get('a') as LocalAgentActor

    // The summary cache is per store: a second store would never see the
    // activity the adopted sessions record.
    expect(after.store).toBe(before.store)
    expect(after.state.store).toBe(after.store)
  })

  it('a registry left over from before the reload adopts the state the current one built, never replacing it', async () => {
    // A singleton pinned on globalThis (the notification manager) keeps
    // calling the registry of the module evaluation that created it.
    const stale = await load()
    const current = await reload()
    await current.agentRegistry.get('new-agent').inputs.register({
      id: 'after-reload',
      kind: 'secret',
      scope: { sessionId: 's' },
      blocking: true,
      payload: {},
    })

    const fromStale = stale.agentRegistry.get('new-agent') as LocalAgentActor

    expect(fromStale.state).toBe((current.agentRegistry.get('new-agent') as LocalAgentActor).state)
    const next = await reload()
    expect(await next.agentRegistry.get('new-agent').inputs.get('after-reload')).not.toBeNull()
  })

  it('evicting after the reload releases the state the earlier registry built', async () => {
    const original = await load()
    const decision = original.agentRegistry
      .get('a')
      .inputs.reviews.request(reviewDetails, { id: 'review-a' })
    await parked(original, 'a')

    const reloaded = await reload()
    await reloaded.agentRegistry.evict('a')

    await expect(decision).resolves.toBe('timeout')
    expect(reloaded.reviewManager.getPendingReviewsForAgent('a')).toEqual([])
    expect(reloaded.userInputRequestManager.getOpenRequestsForAgent('a')).toEqual([])
  })
})
