/**
 * A test's actor double as callers reach a real actor: through the
 * serializing transport when the suite runs with
 * SUPERAGENT_ACTOR_TRANSPORT=serializing (`npm run test:actor-transport`), as
 * it is otherwise. For a test that mocks the actor module whole, whose actors
 * the registry's transport never sees.
 */
import { serializingActor } from '../serializing-actor'
import type { AgentActor } from '../types'

/**
 * Whether this run reaches actors through the transport: a test of what only
 * an actor on this machine does (a host-path shortcut) is skipped by it.
 */
export const underActorTransport = process.env.SUPERAGENT_ACTOR_TRANSPORT === 'serializing'

export function viaTestTransport<T extends object>(actor: T): T {
  if (!underActorTransport) return actor
  return serializingActor(actor as unknown as AgentActor) as unknown as T
}
