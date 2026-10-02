import crypto from 'crypto'

// Covers restoring a few saved logins through a remote browser provider; past it the agent goes on without them.
const DEFAULT_TIMEOUT_MS = 10_000

const waiters = new Map<string, () => void>()

/**
 * Start waiting for the host to bring saved logins in this browser up to date
 * after it opens. Null when the host did not say it will answer (older hosts),
 * so browser_open never waits for a reply that is not coming.
 */
export function startHostLoginSync(timeoutMs = DEFAULT_TIMEOUT_MS): { id: string; done: Promise<void> } | null {
  if (process.env.SUPERAGENT_BROWSER_LOGIN_SYNC !== '1') return null
  const id = crypto.randomUUID()
  const done = new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      waiters.delete(id)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    waiters.set(id, finish)
  })
  return { id, done }
}

/** The host finished syncing for `id`; false when nothing is waiting (e.g. it already timed out). */
export function finishHostLoginSync(id: string): boolean {
  const finish = waiters.get(id)
  if (!finish) return false
  finish()
  return true
}
