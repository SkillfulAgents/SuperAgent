import { usernameKey } from './site'
import { heldLoginSchema, type HeldLogin } from './held-values-schema'
import { z } from 'zod'
import { expiringMap } from '@shared/lib/host-state/expiring-map'
import { resetProcessHostState } from '@shared/lib/host-state/scope'

/**
 * Sign-in state the host keeps between the steps of one sign-in, for half an
 * hour (in the shared host state when there is one, else this process's memory):
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

// Sealed in a shared store: the values are what the user typed, passwords included.
const held = expiringMap('held-login', HOLD_MS, heldLoginSchema, { sealed: true })
const identities = expiringMap('sign-in-identity', HOLD_MS, z.string())

function keyOf(agentSlug: string, sessionId: string, site: string): string {
  return `${agentSlug}\u0000${sessionId}\u0000${site}`
}

export async function holdLoginValues(agentSlug: string, sessionId: string, site: string, login: HeldLogin): Promise<void> {
  if (Object.keys(login.values).length === 0) return
  await held.put(keyOf(agentSlug, sessionId, site), login)
}

/** The held sign-in on a site, when it is for this username (any, when none is named). */
export async function heldLoginFor(agentSlug: string, sessionId: string, site: string, username?: string): Promise<HeldLogin | null> {
  const entry = (await held.get(keyOf(agentSlug, sessionId, site))) ?? null
  if (!entry || !username || !entry.username) return entry
  return usernameKey(entry.username) === usernameKey(username) ? entry : null
}

/** Forget held parts once they went into the page. */
export async function releaseHeldValues(agentSlug: string, sessionId: string, site: string, partKeys: string[]): Promise<void> {
  const key = keyOf(agentSlug, sessionId, site)
  const next = await held.update(key, (entry) => ({
    ...entry,
    values: Object.fromEntries(Object.entries(entry.values).filter(([part]) => !partKeys.includes(part))),
  }))
  if (next && Object.keys(next.values).length === 0) await held.delete(key)
}

/** The user declined, or signed in on the page by hand: nothing they typed for later stays. */
export async function forgetHeldLogin(agentSlug: string, sessionId: string, site: string): Promise<void> {
  await held.delete(keyOf(agentSlug, sessionId, site))
}

export async function rememberSignInIdentity(agentSlug: string, sessionId: string, site: string, username: string): Promise<void> {
  await identities.put(keyOf(agentSlug, sessionId, site), username)
}

export async function recentSignInIdentity(agentSlug: string, sessionId: string, site: string): Promise<string | null> {
  return (await identities.get(keyOf(agentSlug, sessionId, site))) ?? null
}

/** Test seam. */
export function resetHeldLogins(): void {
  resetProcessHostState()
}
