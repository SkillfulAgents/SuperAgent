/**
 * The few values an agent actor must keep across its own restart, as a
 * synchronous key-value store: the runtime-recovery budget and user messages
 * held while a recovery runs. In memory by default (a desktop restart ends
 * the turns those values are about anyway); a deployment whose actor outlives
 * its process supplies a durable one, such as Durable Object `storage.kv`.
 *
 * Synchronous on purpose: the values are read and written in the middle of
 * synchronous state changes, and Durable Object storage offers a sync API.
 */
export interface ActorDurableState {
  get<T>(key: string): T | undefined
  put(key: string, value: unknown): void
  delete(key: string): void
  /** Keys under `prefix`, with their values. */
  list<T>(prefix: string): Array<[string, T]>
}

export function memoryDurableState(): ActorDurableState {
  const values = new Map<string, unknown>()
  return {
    get: <T>(key: string) => (values.has(key) ? structuredClone(values.get(key)) as T : undefined),
    put: (key, value) => {
      values.set(key, structuredClone(value))
    },
    delete: (key) => {
      values.delete(key)
    },
    list: <T>(prefix: string) => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T]),
  }
}

let current: ActorDurableState = memoryDurableState()

/** The store every actor in this process uses; `null` starts a fresh in-memory one. */
export function setActorDurableState(state: ActorDurableState | null): void {
  current = state ?? memoryDurableState()
}

export function actorDurableState(): ActorDurableState {
  return current
}
