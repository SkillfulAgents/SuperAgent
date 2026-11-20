import { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import { rememberSignInIdentity } from './held-values'
import { heldSessionVersion, markSessionHeld, readAccountSession } from './session-service'
import {
  browserOf,
  captureRequest,
  captureResponseSchema,
  type SessionAccount,
  type SessionScope,
  type SignInBaseline,
  type SignInStep,
} from './sign-in-watches'
import { recordAccountUse, type VaultAccount } from './vault-service'

export type { SessionScope, SignInBaseline, SignInStep } from './sign-in-watches'

/**
 * The host's side of saved sessions (the container's browser-session.ts
 * reads and writes them in the browser):
 *
 * - Restore: on the first page of a sign-in, an account the agent names (or
 *   the user picks in the card) signs in with a session saved from an
 *   earlier sign-in, in place of its values, unless the agent's browser
 *   already held that capture (then it did not sign the agent in, and the
 *   values fill).
 * - Capture: the site's state (cookies and storage) is read just before a
 *   sign-in step goes in, then watched for three minutes, from a first look
 *   right after it. A change is saved to the step's account at once when
 *   the site held still before it (a sign-in landing) or holds still after
 *   it; while it keeps changing (a cookie rewritten on every page), at most
 *   once a minute; and a last time when the watch ends. A phone prompt
 *   approved, a passkey in the owner's hands, a provider's redirect landing
 *   back, a token the app stores all complete a sign-in without another
 *   call.
 *
 * Anything that may change who is signed in ends a watch. Every sign-in step
 * and restore ends all the others in the agent's browser (sites share
 * cookies through a parent domain, a sign-in lands on another site), but for
 * the sign-ins it is the provider step of. While the user has the browser
 * (a hand-over, a sign-in card), a watch does not look: their finishing it
 * goes on with the sign-in for the account's owner and ends it for anyone
 * else. The browser closing, opening again or changing hands ends it too.
 *
 * What a restore puts in is not watched: a session saved again for every
 * cookie a site rewrites on each page would go round between agents.
 *
 * Watches live in the agent's state (AgentSignInWatches), where its actor
 * runs: a timer per sign-in, which outlives the request that started it.
 */

// ── Restore ────────────────────────────────────────────────────────────────

/** How a restore ended, for the agent's tool result (the container's loginSessionReportSchema). */
export type SessionResolution = {
  type: 'session'
  site: string
  username: string
  restored: boolean
  changed?: boolean
  cleared?: boolean
  observation?: Record<string, unknown>
}

const restoredSchema = z.object({
  restored: z.literal(true),
  observation: z.record(z.string(), z.unknown()).optional(),
}).loose()
const restoreFailureSchema = z.object({ touched: z.boolean(), changed: z.boolean(), cleared: z.boolean() }).loose()

/**
 * Sign the agent in with the account's saved session instead of its values,
 * when it has one for this browser that the browser has not held. Null: go
 * on and fill (no such session, or the restore failed before it moved the
 * page). A restore that moved the page counts as tried either way: the same
 * capture never goes in twice, so the agent's next call fills.
 *
 * `picked`: the user picked the account in the card. Their use, in the audit
 * log; and a pick that grants the account grants it once the restore moved
 * the page, before the browser is marked as holding it (the mark is on the
 * grant). A restore that moved nothing grants nothing: the fill decides.
 */
export async function restoreSavedSession(input: {
  agentSlug: string
  sessionId: string
  account: VaultAccount
  picked?: { userId: string | null; grant?: () => Promise<void> }
}): Promise<SessionResolution | null> {
  const { agentSlug, sessionId, account, picked } = input
  try {
    const browser = await browserOf(agentRegistry.get(agentSlug).container, sessionId)
    if (!browser) return null
    const saved = await readAccountSession(account, browser.type, { unlessVersion: await heldSessionVersion(agentSlug, account.id) })
    if (!saved) return null
    // Whatever comes of it, what the browser holds is no longer a sign-in being watched.
    await beginSignInStep(agentSlug, { site: account.site, username: account.username, accountId: account.id })
    const response = await agentRegistry.get(agentSlug).container.fetch('/browser/session/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, site: account.site, origin: account.origin, bundle: saved.bundle }),
    })
    const data: unknown = await response.json().catch(() => null)
    const restored = response.ok ? restoredSchema.safeParse(data) : null
    const result = { type: 'session' as const, site: account.site, username: account.username }
    if (restored?.success) {
      // The session's last step on the site: this account's (restoresHere, and whether a step after it is watched).
      await rememberSignInIdentity(agentSlug, sessionId, account.site, account.username)
      await picked?.grant?.()
      await markSessionHeld({ agentSlug, account, version: saved.version })
      await recordAccountUse({
        agentSlug,
        accountId: account.id,
        sessionId,
        ...(picked ? { userId: picked.userId } : {}),
        password: false,
        by: picked ? 'user' : 'vault',
        session: true,
      })
      return { ...result, restored: true, ...(restored.data.observation ? { observation: restored.data.observation } : {}) }
    }
    // Failed before it moved the page: as if never tried. After: tried, whatever it left.
    const failure = restoreFailureSchema.safeParse(data)
    if (!failure.success || !failure.data.touched) return null
    await picked?.grant?.()
    await markSessionHeld({ agentSlug, account, version: saved.version })
    return { ...result, restored: false, changed: failure.data.changed, cleared: failure.data.cleared }
  } catch (error) {
    console.error('[browser-vault] Restoring a saved session failed:', error instanceof Error ? error.message : error)
    return null
  }
}

// ── Capture ────────────────────────────────────────────────────────────────

/**
 * The site's state as a sign-in step is about to go in (or a provider to be
 * named), for a watch after it to compare with. Null when there is nothing
 * to watch: the session holds no browser, or the site cannot be read.
 */
export async function sessionBaseline(input: { agentSlug: string; sessionId: string; scope: SessionScope }): Promise<SignInBaseline | null> {
  const { agentSlug, sessionId, scope } = input
  try {
    const actor = agentRegistry.get(agentSlug)
    const browser = await browserOf(actor.container, sessionId)
    if (!browser) return null
    const response = await captureRequest(actor, { sessionId, site: scope.site, origin: scope.origin, peek: true })
    if (!response.ok) return null
    const { hash } = captureResponseSchema.parse(await response.json())
    return { browserType: browser.type, generation: browser.generation, scope, hash }
  } catch (error) {
    console.error('[browser-vault] Reading a site before a sign-in step failed:', error instanceof Error ? error.message : error)
    return null
  }
}

/** A sign-in step for the account went in: the agent watches its site (AgentSignInWatches.watch). */
export async function watchSignIn(input: { agentSlug: string; sessionId: string; account: SessionAccount; baseline: SignInBaseline | null }): Promise<void> {
  const { agentSlug, ...watch } = input
  await agentRegistry.get(agentSlug).signIns.watch(watch)
}

/** A sign-in step is about to go into the agent's browser: the sign-ins it ends stop (AgentSignInWatches.beginStep). */
export async function beginSignInStep(agentSlug: string, step: SignInStep): Promise<void> {
  await agentRegistry.get(agentSlug).signIns.beginStep(step)
}

/** The user is done with the session's browser (AgentSignInWatches.afterHandOver). */
export async function watchAfterHandOver(input: { agentSlug: string; sessionId: string; viewer: string | null; site: string | null }): Promise<void> {
  const { agentSlug, ...handOver } = input
  await agentRegistry.get(agentSlug).signIns.afterHandOver(handOver)
}

/** Stop saving the account's sessions from these agents' browsers (the ones it is granted to): deleted, forgotten, or revoked. */
export async function stopSessionWatches(accountId: string, agentSlugs: string[]): Promise<void> {
  await Promise.all(agentSlugs.map((agentSlug) => agentRegistry.get(agentSlug).signIns.stopAccount(accountId)))
}
