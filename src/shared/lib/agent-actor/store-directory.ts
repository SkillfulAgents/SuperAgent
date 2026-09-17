/**
 * How a process-wide router reaches the stores the actors own.
 *
 * Per-agent in-memory state (open user-input requests, parked reviews and
 * re-auth waits, computer-use grants) is a field of the agent's actor. The
 * singletons that used to hold it keyed by slug are routers now: they answer
 * a call that arrives with an id or a slug but no actor handle, and they run
 * the process-wide sweeps (reject everything at shutdown, complete every wait
 * on an account). For both they need the actors' stores, and the registry —
 * the one owner of the handles — hands them a directory when it is created.
 *
 * A directory never holds state of its own: `get` creates the handle the way
 * `agentRegistry.get` does, `peek` answers only for a handle that exists, and
 * `all` is the handles that exist now. Nothing can be stored for an agent
 * that has no handle, so a sweep over `all()` is complete.
 */
import type { AgentSlug } from './types'

export interface AgentStoreDirectory<T> {
  /** The store of one agent, creating the actor handle on first use. Never does I/O. */
  get(slug: AgentSlug): T
  /** The store if the agent has a handle; a read for an agent nothing has touched finds nothing. */
  peek(slug: AgentSlug): T | undefined
  /** Every store that exists now: one per live handle. */
  all(): T[]
}

/**
 * The directory a router holds: detached until the registry attaches one.
 * Before that, a read finds nothing and a sweep has nothing to do — the
 * state cannot exist without the handles — while a write for an agent has
 * nowhere to go and says so.
 */
export class AttachedStores<T> implements AgentStoreDirectory<T> {
  private directory: AgentStoreDirectory<T> | null = null

  constructor(private readonly what: string) {}

  attach(directory: AgentStoreDirectory<T> | null): void {
    this.directory = directory
  }

  get(slug: AgentSlug): T {
    if (!this.directory) {
      throw new Error(`No ${this.what} for agent ${slug}: the agent registry has not attached the agents' stores`)
    }
    return this.directory.get(slug)
  }

  peek(slug: AgentSlug): T | undefined {
    return this.directory?.peek(slug)
  }

  all(): T[] {
    return this.directory?.all() ?? []
  }
}
