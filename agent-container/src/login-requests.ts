import type { PreparedLogin } from './login-fill'

/**
 * request_login calls whose fields were located, by tool use id. The tool
 * prepares its request through the server; the host then reads the request's
 * context (to draw the form) and posts the user's values against it. Both
 * can arrive before preparation finishes, so readers can wait for it.
 */

type Entry = { prepared: PreparedLogin } | { problems: string[] }

const entries = new Map<string, Entry>()
const waiters = new Map<string, Array<() => void>>()
/** Requests being prepared now. */
const preparing = new Set<string>()

/**
 * Claim a request for preparation: false when it is being prepared or
 * already was, so a second prepare can never remap the fields of a request
 * the host has shown (a username field is not redacted; a password field is).
 */
export function beginPreparedLogin(toolUseId: string): boolean {
  if (preparing.has(toolUseId) || entries.has(toolUseId)) return false
  preparing.add(toolUseId)
  return true
}

function settle(toolUseId: string, entry: Entry): void {
  preparing.delete(toolUseId)
  entries.set(toolUseId, entry)
  for (const wake of waiters.get(toolUseId) ?? []) wake()
  waiters.delete(toolUseId)
}

export function putPreparedLogin(prepared: PreparedLogin): void {
  settle(prepared.toolUseId, { prepared })
}

/** Preparation failed: readers learn why instead of waiting it out. */
export function failPreparedLogin(toolUseId: string, problems: string[]): void {
  settle(toolUseId, { problems })
}

export function getPreparedLogin(toolUseId: string): PreparedLogin | null {
  const entry = entries.get(toolUseId)
  return entry && 'prepared' in entry ? entry.prepared : null
}

/** The request's entry once preparation has settled, or null after `timeoutMs`. */
export function waitForPreparedLogin(toolUseId: string, timeoutMs: number): Promise<Entry | null> {
  const known = entries.get(toolUseId)
  if (known) return Promise.resolve(known)
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer)
      resolve(entries.get(toolUseId) ?? null)
    }
    const timer = setTimeout(() => {
      const rest = (waiters.get(toolUseId) ?? []).filter((waiter) => waiter !== wake)
      if (rest.length) waiters.set(toolUseId, rest)
      else waiters.delete(toolUseId)
      resolve(null)
    }, timeoutMs)
    waiters.set(toolUseId, [...(waiters.get(toolUseId) ?? []), wake])
  })
}

/** The request is over (answered, cancelled, or its tool call ended). */
export function forgetPreparedLogin(toolUseId: string): void {
  entries.delete(toolUseId)
  preparing.delete(toolUseId)
}

/** The browser closed: no prepared request can be filled any more. */
export function forgetAllPreparedLogins(): void {
  entries.clear()
  preparing.clear()
}
