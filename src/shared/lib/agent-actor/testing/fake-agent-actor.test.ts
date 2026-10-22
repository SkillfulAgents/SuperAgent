import { describe, expect, it, vi } from 'vitest'
import { createFakeAgentActor, createFakeRegistry } from './fake-agent-actor'
import { hostFromManagerMock } from './host-from-manager-mock'

describe('createFakeAgentActor', () => {
  it('gives every method a mock on first access and keeps it', async () => {
    const actor = createFakeAgentActor('a')
    await actor.messages.deliver({ sessionId: 's1', content: 'hi' })
    expect(actor.messages.deliver).toHaveBeenCalledWith({ sessionId: 's1', content: 'hi' })
    expect(actor.messages.deliver).toBe(actor.messages.deliver)
    expect(actor.sessions.exists).not.toHaveBeenCalled()
  })

  it('covers every group of the contract, config and memories included', async () => {
    const actor = createFakeAgentActor('a')
    await actor.config.get('instructions')
    expect(actor.config.get).toHaveBeenCalledWith('instructions')
    expect(actor.usage.daily).not.toHaveBeenCalled()
    expect(await actor.files.stat('x')).toBeUndefined()
    await actor.memories.list()
    await actor.memories.read('style.md')
    await actor.memories.save('style.md', 'content', 'revision')
    expect(actor.memories.list).toHaveBeenCalledOnce()
    expect(actor.memories.read).toHaveBeenCalledWith('style.md')
    expect(actor.memories.save).toHaveBeenCalledWith('style.md', 'content', 'revision')
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
    expect(actor.inputs.computerUse.setGrabbedApp('Calculator')).toBeUndefined()
    expect(actor.inputs.get('r1')).toBeUndefined()
  })
})

describe('createFakeRegistry', () => {
  it('hands out one fake per slug, until it is evicted', async () => {
    const registry = createFakeRegistry()
    const a = registry.get('a')
    expect(registry.get('a')).toBe(a)
    expect(registry.actors.has('c')).toBe(false)
    expect(registry.fake('a').sessions.list).toBe(registry.get('a').sessions.list)

    await registry.evict('a')
    expect(registry.actors.has('a')).toBe(false)
    expect(registry.get('a')).not.toBe(a)
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
