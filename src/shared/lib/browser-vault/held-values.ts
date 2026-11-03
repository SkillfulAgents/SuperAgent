import { usernameKey } from './site'
import type { VaultOwner } from './vault-service'

/**
 * Sign-in state the host keeps between the steps of one sign-in, in this
 * process's memory only:
 *
 * - Held values: what the user entered for a later step (the password asked
 *   together with the email on an email-first page), filled when a later
 *   request_login on the same site maps the field. One sign-in per agent,
 *   session and site at a time; held only once the step they came with went
 *   into the page, dropped once used, when the user declines or signs in by
 *   hand, or after a while.
 * - The identity: the username the last step on the site went in with, so a
 *   step that shows no username field still knows whose account it is.
 *
 * How often a saved password went in is not kept here but in the audit log
 * (login-host's filledTooOften): it has to outlast a session and a restart.
 */

const HOLD_MS = 30 * 60 * 1000

export interface HeldLogin {
  username: string | null
  /** By part key ('password', 'text:…'). */
  values: Record<string, string>
  /** Where the user typed them: they go only where a saved account's would (vaultFillsInto). */
  origin: string
  /** Add them to the owner's account once they are filled: the user checked "Save for later". */
  save: { owner: VaultOwner; origin: string } | null
}

interface Entry<T> {
  value: T
  timer: ReturnType<typeof setTimeout>
}

const held = new Map<string, Entry<HeldLogin>>()
const identities = new Map<string, Entry<string>>()

function keyOf(agentSlug: string, sessionId: string, site: string): string {
  return `${agentSlug}\u0000${sessionId}\u0000${site}`
}

function put<T>(map: Map<string, Entry<T>>, key: string, value: T): void {
  clearTimeout(map.get(key)?.timer)
  const timer = setTimeout(() => map.delete(key), HOLD_MS)
  timer.unref?.()
  map.set(key, { value, timer })
}

function drop<T>(map: Map<string, Entry<T>>, key: string): void {
  clearTimeout(map.get(key)?.timer)
  map.delete(key)
}

export function holdLoginValues(agentSlug: string, sessionId: string, site: string, login: HeldLogin): void {
  if (Object.keys(login.values).length === 0) return
  put(held, keyOf(agentSlug, sessionId, site), login)
}

/** The held sign-in on a site, when it is for this username (any, when none is named). */
export function heldLoginFor(agentSlug: string, sessionId: string, site: string, username?: string): HeldLogin | null {
  const entry = held.get(keyOf(agentSlug, sessionId, site))?.value ?? null
  if (!entry || !username || !entry.username) return entry
  return usernameKey(entry.username) === usernameKey(username) ? entry : null
}

/** Forget held parts once they went into the page. */
export function releaseHeldValues(agentSlug: string, sessionId: string, site: string, partKeys: string[]): void {
  const key = keyOf(agentSlug, sessionId, site)
  const entry = held.get(key)
  if (!entry) return
  const values = Object.fromEntries(Object.entries(entry.value.values).filter(([part]) => !partKeys.includes(part)))
  if (Object.keys(values).length === 0) drop(held, key)
  else entry.value = { ...entry.value, values }
}

/** The user declined, or signed in on the page by hand: nothing they typed for later stays. */
export function forgetHeldLogin(agentSlug: string, sessionId: string, site: string): void {
  drop(held, keyOf(agentSlug, sessionId, site))
}

export function rememberSignInIdentity(agentSlug: string, sessionId: string, site: string, username: string): void {
  put(identities, keyOf(agentSlug, sessionId, site), username)
}

export function recentSignInIdentity(agentSlug: string, sessionId: string, site: string): string | null {
  return identities.get(keyOf(agentSlug, sessionId, site))?.value ?? null
}

/** Test seam. */
export function resetHeldLogins(): void {
  for (const map of [held, identities] as Array<Map<string, Entry<unknown>>>) {
    for (const entry of map.values()) clearTimeout(entry.timer)
    map.clear()
  }
}
