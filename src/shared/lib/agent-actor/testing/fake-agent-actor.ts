/**
 * Test doubles for the agent actor.
 *
 * `createFakeAgentActor(slug, overrides)` returns an `AgentActor` whose every
 * method is a `vi.fn()`, created on first access, so a test only spells out
 * the behaviour it cares about:
 *
 *   const actor = createFakeAgentActor('a', {
 *     sessions: { exists: vi.fn().mockResolvedValue(true) },
 *   })
 *   expect(actor.messages.send).toHaveBeenCalledWith('s1', 'hi')
 *
 * `createFakeRegistry(actors)` returns an `AgentRegistry` that hands those
 * out and fabricates a fake for any slug it has not seen. Mock the registry
 * module with it to test a consumer against the actor contract instead of
 * against the local implementation's leaf modules:
 *
 *   vi.mock('@shared/lib/agent-actor', async () => {
 *     const { createFakeRegistry } = await import('@shared/lib/agent-actor/testing/fake-agent-actor')
 *     return { agentRegistry: createFakeRegistry() }
 *   })
 */
import { vi, type Mock } from 'vitest'
import type { AgentActor, AgentRegistry, AgentSlug } from '../types'

type Fn = (...args: never[]) => unknown

/** Every method of a group becomes a mock; nested groups recurse. */
export type FakeOps<T> = {
  [K in keyof T]: T[K] extends Fn ? Mock<T[K]> : T[K] extends object ? FakeOps<T[K]> : T[K]
}

export type FakeAgentActor = {
  readonly slug: AgentSlug
  readonly container: FakeOps<AgentActor['container']>
  readonly sessions: FakeOps<AgentActor['sessions']>
  readonly messages: FakeOps<AgentActor['messages']>
  readonly inputs: FakeOps<AgentActor['inputs']>
  readonly usage: FakeOps<AgentActor['usage']>
  readonly files: FakeOps<AgentActor['files']>
  readonly config: FakeOps<AgentActor['config']>
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends Fn ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] }

export type FakeActorOverrides = DeepPartial<Omit<AgentActor, 'slug'>>

/** The input sub-groups; anything else accessed on `inputs` is a method. */
const INPUT_GROUPS = new Set(['reviews', 'computerUse', 'mcpReauth'])

function fakeGroup(overrides: Record<string, unknown> = {}, nested: Set<string> = new Set()): Record<string, unknown> {
  const members = new Map<string, unknown>(Object.entries(overrides))
  return new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== 'string') return undefined
        // Let vitest's matchers and Node's inspection ask about promise-ness etc.
        if (name === 'then' || name === 'toJSON' || name === 'constructor') return undefined
        let member = members.get(name)
        if (member === undefined) {
          member = nested.has(name) ? fakeGroup() : vi.fn()
          members.set(name, member)
        }
        return member
      },
      has(_target, name) {
        return typeof name === 'string'
      },
      ownKeys() {
        return [...members.keys()]
      },
      getOwnPropertyDescriptor(_target, name) {
        if (typeof name !== 'string' || !members.has(name)) return undefined
        return { value: members.get(name), enumerable: true, configurable: true, writable: false }
      },
    },
  )
}

export function createFakeAgentActor(slug: AgentSlug, overrides: FakeActorOverrides = {}): FakeAgentActor {
  const inputs = overrides.inputs as Record<string, unknown> | undefined
  return {
    slug,
    container: fakeGroup(overrides.container as Record<string, unknown>) as FakeAgentActor['container'],
    sessions: fakeGroup(overrides.sessions as Record<string, unknown>) as FakeAgentActor['sessions'],
    messages: fakeGroup(overrides.messages as Record<string, unknown>) as FakeAgentActor['messages'],
    inputs: fakeGroup(
      inputs && {
        ...inputs,
        ...Object.fromEntries(
          [...INPUT_GROUPS]
            .filter((group) => inputs[group] !== undefined)
            .map((group) => [group, fakeGroup(inputs[group] as Record<string, unknown>)]),
        ),
      },
      INPUT_GROUPS,
    ) as FakeAgentActor['inputs'],
    usage: fakeGroup(overrides.usage as Record<string, unknown>) as FakeAgentActor['usage'],
    files: fakeGroup(overrides.files as Record<string, unknown>) as FakeAgentActor['files'],
    config: fakeGroup(overrides.config as Record<string, unknown>) as FakeAgentActor['config'],
  }
}

export interface FakeRegistry extends AgentRegistry {
  /** The fakes handed out so far, by slug. */
  readonly actors: Map<AgentSlug, FakeAgentActor>
  /** Which slugs `running()` reports; defaults to none. */
  runningSlugs: AgentSlug[]
  /** The fake for a slug, typed as a fake (creating it if needed). */
  fake(slug: AgentSlug): FakeAgentActor
}

export function createFakeRegistry(
  seed: FakeAgentActor[] = [],
  options: { runningSlugs?: AgentSlug[] } = {},
): FakeRegistry {
  const actors = new Map<AgentSlug, FakeAgentActor>(seed.map((actor) => [actor.slug, actor]))
  const fake = (slug: AgentSlug): FakeAgentActor => {
    let actor = actors.get(slug)
    if (!actor) {
      actor = createFakeAgentActor(slug)
      actors.set(slug, actor)
    }
    return actor
  }
  const registry: FakeRegistry = {
    actors,
    runningSlugs: options.runningSlugs ?? [],
    fake,
    get: (slug) => fake(slug) as unknown as AgentActor,
    peek: (slug) => actors.get(slug) as unknown as AgentActor | undefined,
    running: () => registry.runningSlugs.map((slug) => fake(slug) as unknown as AgentActor),
    evict: (slug) => {
      actors.delete(slug)
    },
    evictAll: () => {
      actors.clear()
    },
  }
  return registry
}
