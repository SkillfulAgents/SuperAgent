/**
 * Which agent's object serves the current request in this isolate. Cloudflare can run several
 * Durable Objects of one class in one isolate, and SuperAgent's module state is shared by all of
 * them, while each object's storage may be touched only from that object's own requests. So an
 * agent's object is called directly only inside its own request, and through its stub otherwise.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentActor, AgentSlug } from '@shared/lib/agent-actor/types'
import type { CloudflareAgentActor } from './cloudflare-agent-actor'

const serving = new AsyncLocalStorage<{ slug: AgentSlug; object: CloudflareAgentActor }>()

/** Runs `work` as the agent's own object: what it starts there (background work too) stays its own. */
export function runAsAgentObject<T>(slug: AgentSlug, object: CloudflareAgentActor, work: () => T): T {
  return serving.run({ slug, object }, work)
}

/** The agent's object when it is the one serving the current request; null otherwise. */
export function servingAgentObject(slug: AgentSlug): CloudflareAgentActor | null {
  const current = serving.getStore()
  return current?.slug === slug ? current.object : null
}

/**
 * The agent's actor, chosen at each use: inside the agent's own object it is the actor in this
 * isolate, and anywhere else the actor in that object, reached through `remote`. Chosen per use,
 * not once: an isolate can serve the agent's object and other callers.
 */
export function ownedHere(slug: AgentSlug, local: AgentActor, remote: AgentActor): AgentActor {
  return new Proxy(local, {
    get(_target, key) {
      return Reflect.get(servingAgentObject(slug) ? local : remote, key)
    },
  })
}
