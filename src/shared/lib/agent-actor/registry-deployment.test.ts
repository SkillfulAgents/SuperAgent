/**
 * A deployment whose agents live outside this process tells `agentRegistry`
 * where each agent's files are and how callers reach it, once at boot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInMemorySessionStore } from './testing/in-memory-session-store'
import { loopbackActor } from './network-actor'
import type { AgentActor } from './types'

// A runtime the actor's process has not synced yet: its cache says stopped, the runner says running.
const runtime = vi.hoisted(() => {
  const client = {
    fetch: vi.fn(async (path: string) => Response.json(path === '/sessions' || path === '/inputs/pending' ? [] : {})),
    sendMessage: vi.fn(async () => ({})),
  }
  return {
    client,
    getCachedInfo: vi.fn(() => ({ status: 'stopped', port: null })),
    syncAgentStatus: vi.fn(async () => ({ status: 'running', port: 4100 })),
    getClient: () => client,
    noteSessionActivity: vi.fn(),
  }
})
vi.mock('@shared/lib/container/container-host', () => ({
  containerHost: { attachAgentWorkspaces: vi.fn(), attachAgentSessions: vi.fn(), dropRuntime: vi.fn(), clearRuntimes: vi.fn(), runtime: () => runtime },
}))
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

afterEach(async () => {
  await evictAll?.()
  evictAll = undefined
})

describe('configureAgentRegistry', () => {
  it('keeps the agent\'s files in the session store the deployment supplies', async () => {
    const { agentRegistry, configureAgentRegistry } = await freshRegistry()
    const store = createInMemorySessionStore('sales-agent')
    configureAgentRegistry({ createSessionStore: () => store })

    await agentRegistry.get('sales-agent').files.putDoc('notes/q3.md', 'Pipeline review on Friday')

    expect(new TextDecoder().decode((await store.files.getDoc('notes/q3.md'))!)).toBe('Pipeline review on Friday')
  })

  it('hands callers the agent through the deployment\'s transport', async () => {
    const { agentRegistry, configureAgentRegistry } = await freshRegistry()
    const store = createInMemorySessionStore('sales-agent')
    const transport = vi.fn((actor: AgentActor) => loopbackActor(actor))
    configureAgentRegistry({ createSessionStore: () => store, transport })

    const actor = agentRegistry.get('sales-agent')
    await actor.files.putDoc('notes/q3.md', 'Pipeline review on Friday')

    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0][0].slug).toBe('sales-agent')
    expect(actor).toBe(transport.mock.results[0].value)
    expect(agentRegistry.get('sales-agent')).toBe(actor)
    expect(new TextDecoder().decode((await store.files.getDoc('notes/q3.md'))!)).toBe('Pipeline review on Friday')
  })

  it('rebuilds a restarted actor from what its runtime reports now, not from the cache it starts with', async () => {
    const { agentRegistry, configureAgentRegistry } = await freshRegistry()
    configureAgentRegistry({ createSessionStore: () => createInMemorySessionStore('sales-agent') })
    const { actorDurableState } = await import('./durable-state')
    // A user message held for a recovery that the restart cut short.
    actorDurableState().put('coalesced:sales-agent:session-7', [{ uuid: 'held-1', text: 'Also check the March invoice' }])

    const result = await agentRegistry.get('sales-agent').sessions.recover()

    expect(result.resent).toEqual(['held-1'])
    expect(runtime.client.sendMessage).toHaveBeenCalledWith('session-7', 'Also check the March invoice', 'held-1', { shouldQuery: true })
    expect(actorDurableState().list('coalesced:')).toEqual([])
  })
})
