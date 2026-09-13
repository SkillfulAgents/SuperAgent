import { describe, expect, it, vi } from 'vitest'
import { createFakeAgentActor, createFakeRegistry } from './fake-agent-actor'
import { hostFromManagerMock } from './host-from-manager-mock'

describe('createFakeAgentActor', () => {
  it('gives every method a mock on first access and keeps it', async () => {
    const actor = createFakeAgentActor('a')
    await actor.messages.send('s1', 'hi')
    expect(actor.messages.send).toHaveBeenCalledWith('s1', 'hi')
    expect(actor.messages.send).toBe(actor.messages.send)
    expect(actor.sessions.exists).not.toHaveBeenCalled()
  })

  it('honours overrides, including nested input groups', async () => {
    const exists = vi.fn().mockResolvedValue(true)
    const submit = vi.fn().mockReturnValue(true)
    const actor = createFakeAgentActor('a', {
      sessions: { exists },
      inputs: { reviews: { submit } },
    })
    await expect(actor.sessions.exists('s1')).resolves.toBe(true)
    expect(actor.inputs.reviews.submit('r1', 'allow')).toBe(true)
    // Sibling groups and untouched methods are still plain mocks.
    expect(actor.inputs.computerUse.grabbedApp()).toBeUndefined()
    expect(actor.inputs.get('r1')).toBeUndefined()
  })
})

describe('createFakeRegistry', () => {
  it('hands out one fake per slug and reports only the slugs told to be running', () => {
    const registry = createFakeRegistry([], { runningSlugs: ['b'] })
    const a = registry.get('a')
    expect(registry.get('a')).toBe(a)
    expect(registry.peek('c')).toBeUndefined()
    expect(registry.running().map((actor) => actor.slug)).toEqual(['b'])
    expect(registry.fake('a').sessions.list).toBe(registry.get('a').sessions.list)

    registry.evict('a')
    expect(registry.peek('a')).toBeUndefined()
  })
})

describe('hostFromManagerMock', () => {
  it('binds the slug for runtime methods and forwards host methods as they are', async () => {
    const manager = {
      ensureRunning: vi.fn().mockResolvedValue('client'),
      getCachedInfo: vi.fn().mockReturnValue({ status: 'running', port: 1 }),
      removeClient: vi.fn(),
      clearClients: vi.fn(),
      getRunningAgentIds: vi.fn().mockReturnValue(['a']),
      onBeforeContainerStop: null as null | ((slug: string) => Promise<void>),
    }
    const host = hostFromManagerMock(manager) as {
      runtime(slug: string): { ensureRunning(): Promise<string>; getCachedInfo(): unknown; dispose(): void; slug: string }
      dropRuntime(slug: string): void
      clearRuntimes(): void
      getRunningAgentIds(): string[]
      onBeforeContainerStop: ((slug: string) => Promise<void>) | null
    }

    const runtime = host.runtime('a')
    expect(runtime.slug).toBe('a')
    await expect(runtime.ensureRunning()).resolves.toBe('client')
    expect(manager.ensureRunning).toHaveBeenCalledWith('a')
    expect(runtime.getCachedInfo()).toEqual({ status: 'running', port: 1 })
    expect(manager.getCachedInfo).toHaveBeenCalledWith('a')
    runtime.dispose()
    expect(manager.removeClient).toHaveBeenCalledWith('a')

    host.dropRuntime('b')
    expect(manager.removeClient).toHaveBeenCalledWith('b')
    host.clearRuntimes()
    expect(manager.clearClients).toHaveBeenCalledTimes(1)
    expect(host.getRunningAgentIds()).toEqual(['a'])

    const hook = async () => {}
    host.onBeforeContainerStop = hook
    expect(manager.onBeforeContainerStop).toBe(hook)
    expect(host.runtime('a')).toBe(runtime)
  })
})
