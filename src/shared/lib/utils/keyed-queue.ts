/**
 * Serialize work that shares a key within this process. Calls for the same
 * key run one after another in arrival order; calls for different keys run
 * independently. Used where a write is a compare-and-set against the row's
 * current state: the SQL guard keeps the write correct against any other
 * process, and this queue keeps a burst of in-process callers from spending
 * their retries on each other.
 */
const tails = new Map<string, Promise<unknown>>()

export function serializeByKey<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  // A failed predecessor must not fail its successors; they only wait for it.
  const run = previous.then(work, work)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  tails.set(key, settled)
  void settled.then(() => {
    if (tails.get(key) === settled) tails.delete(key)
  })
  return run
}
