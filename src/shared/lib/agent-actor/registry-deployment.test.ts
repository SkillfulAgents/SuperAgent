/**
 * A deployment whose agents live outside this process tells `agentRegistry`
 * where each agent's files are and how callers reach it, once at boot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInMemorySessionStore } from './testing/in-memory-session-store'
import { serializingActor } from './serializing-actor'
import { createRecordingHostPort } from './testing/recording-host-port'
import type { AgentActor } from './types'
import type { SessionStore } from './session-store'

vi.mock('@shared/lib/container/container-host', () => ({
  containerHost: {
    attachAgentWorkspaces: vi.fn(),
    attachAgentSessions: vi.fn(),
    dropRuntime: vi.fn(),
    clearRuntimes: vi.fn(),
    attachAgentIdleAlarms: vi.fn(),
    attachAgentContainerWatches: vi.fn(),
    useWebhookRelayStatus: vi.fn(),
    runtime: () => ({ getCachedInfo: () => ({ status: 'stopped', port: null }), noteSessionActivity: vi.fn() }),
  },
}))
vi.mock('@shared/lib/host/local-host-port', async () => ({
  localHostPort: (await import('./testing/recording-host-port')).createRecordingHostPort().port,
}))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: async () => ({}), mutateSettings: vi.fn() }))
vi.mock('@shared/lib/services/session-service', () => ({}))
vi.mock('@shared/lib/services/session-transcript-append', () => ({
  appendInformationalEntry: vi.fn(),
  appendAssistantEntry: vi.fn(),
}))
vi.mock('@shared/lib/agent-actor/local-transcript-ops', () => ({}))
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentWorkspaceDir: (slug: string) => `/nonexistent/registry-deployment/${slug}`,
}))
vi.mock('@shared/lib/container/connection-runtime-sync', () => ({}))
vi.mock('@shared/lib/services/usage-service', () => ({}))

let evictAll: (() => Promise<void>) | undefined

/** A fresh registry module: the deployment is set once per module evaluation. */
async function freshRegistry() {
  vi.resetModules()
  const registry = await import('./registry')
  evictAll = registry.agentRegistry.evictAll
  return registry
}

/** A deployment with the given parts, and the rest that does nothing. */
const deploymentWith = (parts: { sessionStore: () => SessionStore; transport?: (slug: string, local: AgentActor) => AgentActor }) => ({
  transport: parts.transport ?? ((_slug: string, local: AgentActor) => local),
  sessionStore: parts.sessionStore,
  host: createRecordingHostPort().port,
  removeWorkspace: vi.fn(async () => {}),
  idleTimer: () => ({ set: vi.fn(), clear: vi.fn() }),
  webhookRelayAvailable: vi.fn(async () => true),
})

afterEach(async () => {
  await evictAll?.()
  evictAll = undefined
})

describe('agentRegistry in a deployment', () => {
  it("keeps the agent's files in the session store the deployment supplies", async () => {
    const { agentRegistry, installAgentDeployment } = await freshRegistry()
    const store = createInMemorySessionStore('sales-agent')
    installAgentDeployment(deploymentWith({ sessionStore: () => store }))

    await agentRegistry.get('sales-agent').files.putDoc('notes/q3.md', 'Pipeline review on Friday')

    expect(new TextDecoder().decode((await store.files.getDoc('notes/q3.md'))!)).toBe('Pipeline review on Friday')
  })

  it("hands callers the agent through the deployment's transport, made once per agent", async () => {
    const { agentRegistry, installAgentDeployment } = await freshRegistry()
    const store = createInMemorySessionStore('sales-agent')
    const make = vi.fn((_slug: string, local: AgentActor) => serializingActor(local))
    installAgentDeployment(deploymentWith({ sessionStore: () => store, transport: make }))

    const actor = agentRegistry.get('sales-agent')
    await actor.files.putDoc('notes/q3.md', 'Pipeline review on Friday')

    expect(make).toHaveBeenCalledTimes(1)
    expect(make.mock.calls[0][0]).toBe('sales-agent')
    expect(agentRegistry.get('sales-agent')).toBe(actor)
    expect(new TextDecoder().decode((await store.files.getDoc('notes/q3.md'))!)).toBe('Pipeline review on Friday')
  })

  it("removes a deleted agent's workspace with the deployment's removal", async () => {
    const { installAgentDeployment } = await freshRegistry()
    const installed = deploymentWith({ sessionStore: () => createInMemorySessionStore('sales-agent') })
    installAgentDeployment(installed)
    // The removal module of this registry: freshRegistry loaded both again.
    const { removeAgentWorkspace } = await import('./workspace-removal')

    await removeAgentWorkspace('sales-agent')

    expect(installed.removeWorkspace).toHaveBeenCalledExactlyOnceWith('sales-agent')
  })
})
