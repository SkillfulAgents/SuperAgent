/**
 * One settings read per API request.
 *
 * `getSettings()` reads the database every time, and the rule is to read once
 * per operation and pass the value down. An API request is one operation, but
 * its settings readers are spread over middleware, the handler and the services
 * it calls, so the same row was read two to five times per request. The API's
 * first middleware opens a scope here, and `getSettings()` shares one read
 * between the callers in it.
 *
 * This is not a process cache. The memo lives on the scope object of one
 * request and is unreachable from any other:
 *   - it is dropped when the request's function settles, so a stream the
 *     handler returned, or work it left running, reads afresh;
 *   - a settings write made by this process (in the scope or not) makes it
 *     stale, so the next read goes to the database;
 *   - a write reads the row itself (`readSettingsSnapshot`), never the memo,
 *     so a compare-and-set never starts from a remembered value;
 *   - outside a scope (jobs, startup, tests of a single function) nothing is
 *     remembered at all.
 * What it does not see is a write committed by another process while the
 * request is running: the request keeps the settings it started with, as it
 * would had it read once and passed them down.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

interface SettingsScope {
  /** The read shared by this request, and the write count it was started at. */
  memo?: { reading: Promise<unknown>; writes: number }
  /** Set when the function that opened the scope has settled. */
  ended?: boolean
}

const scopes = new AsyncLocalStorage<SettingsScope>()

/**
 * How many settings writes this process has made. Not settings, and nothing
 * built from them: a memo started before the latest write is not used again,
 * including one held by a request other than the writer's.
 */
let writes = 0

/**
 * Run `fn` as one operation whose `getSettings()` calls share a read. The memo
 * is dropped as soon as `fn` settles; whatever `fn` left running stays in the
 * scope but reads from the database.
 */
export function runWithSettingsMemo<T>(fn: () => Promise<T>): Promise<T> {
  const scope: SettingsScope = {}
  const end = () => {
    scope.ended = true
    scope.memo = undefined
  }
  return scopes.run(scope, () => {
    let result: Promise<T>
    try {
      result = fn()
    } catch (error) {
      end()
      throw error
    }
    return result.finally(end)
  })
}

/**
 * The current scope's settings, read by `read` the first time they are asked
 * for and shared by later and concurrent callers in the scope. Every caller
 * gets its own deep copy, because callers change what they are given. A read
 * that fails is not kept. Outside a scope, or once it has ended, this is
 * `read()`.
 */
export async function requestScopedSettings<T>(read: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore()
  if (!scope || scope.ended) return read()
  let memo = scope.memo
  if (!memo || memo.writes !== writes) {
    const reading = read()
    memo = { reading, writes }
    scope.memo = memo
    reading.catch(() => {
      if (scope.memo?.reading === reading) scope.memo = undefined
    })
  }
  return structuredClone(await memo.reading) as T
}

/**
 * The stored settings were written or deleted by this process: no memo started
 * before now is used again.
 */
export function settingsWritten(): void {
  writes++
  const scope = scopes.getStore()
  if (scope) scope.memo = undefined
}
