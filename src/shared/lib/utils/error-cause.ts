/** The first error of `type` in the `cause` chain; stops on a cycle. */
export function findErrorInCauseChain<T extends Error>(error: unknown, type: abstract new (...args: never[]) => T): T | null {
  const seen = new Set<unknown>()
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    if (current instanceof type) return current
    seen.add(current)
  }
  return null
}
