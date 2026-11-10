import { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import { background } from '@shared/lib/background'
import { getSettings } from '@shared/lib/config/settings'
import { rememberSignInIdentity } from './held-values'
import { heldSessionVersion, markSessionHeld, readAccountSession, saveAccountSession } from './session-service'
import { registrableDomain, usernameKey } from './site'
import { sessionBundleSchema, type BrowserType } from './vault-schemas'
import { recordAccountUse, type VaultAccount } from './vault-service'

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
 * Watches live in this process's memory, like held values.
 */

const browserStatusSchema = z.object({
  active: z.boolean(),
  sessionId: z.string().nullable(),
  location: z.enum(['host', 'container']).nullable(),
  generation: z.number().optional(),
}).loose()

/** The browser a session holds open: its type (sessions are kept by it), and which opening of it this is. */
interface SessionBrowser {
  type: BrowserType
  generation: number | null
}

/** The browser the session holds open; null when it holds none. */
async function browserOf(agentSlug: string, sessionId: string): Promise<SessionBrowser | null> {
  const response = await agentRegistry.get(agentSlug).container.fetch('/browser/status')
  if (!response.ok) return null
  const status = browserStatusSchema.safeParse(await response.json().catch(() => null))
  if (!status.success || !status.data.active || status.data.sessionId !== sessionId) return null
  const type = status.data.location === 'container' ? 'container' : status.data.location === 'host' ? getSettings().app?.hostBrowserProvider ?? null : null
  return type ? { type, generation: status.data.generation ?? null } : null
}

type SessionAccount = Pick<VaultAccount, 'id' | 'site' | 'origin' | 'ownerId' | 'via'>

/** A sign-in step about to go into the agent's browser: on a site, for a username (or no one), with a saved account or not. */
export interface SignInStep {
  site: string
  username: string | null
  accountId: string | null
}

/** Where a sign-in's session is read: the account's site, and the origin of its sign-in page. */
export interface SessionScope {
  site: string
  origin: string
}

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
    const browser = await browserOf(agentSlug, sessionId)
    if (!browser) return null
    const saved = await readAccountSession(account, browser.type, { unlessVersion: await heldSessionVersion(agentSlug, account.id) })
    if (!saved) return null
    // Whatever comes of it, what the browser holds is no longer a sign-in being watched.
    beginSignInStep(agentSlug, { site: account.site, username: account.username, accountId: account.id })
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
      rememberSignInIdentity(agentSlug, sessionId, account.site, account.username)
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

const WATCH_MS = 3 * 60_000
/** The first look after a step: the page has moved on by then, and the agent has not closed the browser yet. */
const FIRST_LOOK_MS = 2_000
const POLL_MS = 15_000
/** Saved at most this often while the site keeps changing (a site that rewrites a cookie on every page): the last state is saved when the watch ends. */
const SAVE_EVERY_MS = 60_000
/** How long a sign-in step's account is remembered for a hand-over that finishes it (as held values are kept). */
const SIGN_IN_MEMORY_MS = 30 * 60_000

const captureResponseSchema = z.object({ hash: z.string(), bundle: sessionBundleSchema.optional() }).loose()

/** The site's state just before a sign-in step went in: a capture is the step's only once it differs. */
export interface SignInBaseline {
  browserType: BrowserType
  /** The opening of the browser it was read in (/browser/status): a browser opened again since holds none of the step. */
  generation: number | null
  scope: SessionScope
  hash: string
}

/** A sign-in being watched, or remembered for a hand-over: whose it is, where, and the state last seen as the account's. */
interface SignIn {
  agentSlug: string
  sessionId: string
  account: SessionAccount
  browserType: BrowserType
  generation: number | null
  scope: SessionScope
  /** The site's state before the step, or as last saved: a capture is saved only when it differs. */
  hash: string
}

interface Watch extends SignIn {
  key: string
  until: number
  savedAt: number | null
  /** The fingerprint the last look saw, and whether it differed from what was saved then. */
  lastLook: { hash: string; changed: boolean }
  timer: ReturnType<typeof setTimeout> | null
  stopped: boolean
}

const watches = new Map<string, Watch>()
/** Each session's last sign-in, for a hand-over that finishes it. */
const lastSignIns = new Map<string, SignIn & { at: number }>()

const watchKey = (agentSlug: string, sessionId: string, site: string) => `${agentSlug}\u0000${sessionId}\u0000${site}`
const sessionKey = (agentSlug: string, sessionId: string) => `${agentSlug}\u0000${sessionId}`
const ofAgent = (key: string, agentSlug: string) => key.startsWith(`${agentSlug}\u0000`)

function capture(agentSlug: string, body: Record<string, unknown>): Promise<Response> {
  return agentRegistry.get(agentSlug).container.fetch('/browser/session/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * The site's state as a sign-in step is about to go in (or a provider to be
 * named), for a watch after it to compare with. Null when there is nothing
 * to watch: the session holds no browser, or the site cannot be read.
 */
export async function sessionBaseline(input: { agentSlug: string; sessionId: string; scope: SessionScope }): Promise<SignInBaseline | null> {
  const { agentSlug, sessionId, scope } = input
  try {
    const browser = await browserOf(agentSlug, sessionId)
    if (!browser) return null
    const response = await capture(agentSlug, { sessionId, site: scope.site, origin: scope.origin, peek: true })
    if (!response.ok) return null
    const { hash } = captureResponseSchema.parse(await response.json())
    return { browserType: browser.type, generation: browser.generation, scope, hash }
  } catch (error) {
    console.error('[browser-vault] Reading a site before a sign-in step failed:', error instanceof Error ? error.message : error)
    return null
  }
}

function stop(watch: Watch): void {
  watch.stopped = true
  if (watch.timer) clearTimeout(watch.timer)
  if (watches.get(watch.key) === watch) watches.delete(watch.key)
}

function schedule(watch: Watch, delayMs: number): void {
  if (watch.stopped) return
  watch.timer = setTimeout(() => {
    watch.timer = null
    background(() => tick(watch), { name: 'browser-vault.session-watch' })
  }, delayMs)
  watch.timer.unref?.()
}

function startWatch(signIn: SignIn, firstLookMs: number): void {
  const key = watchKey(signIn.agentSlug, signIn.sessionId, signIn.scope.site)
  const previous = watches.get(key)
  if (previous) stop(previous)
  const watch: Watch = { ...signIn, key, until: Date.now() + WATCH_MS, savedAt: null, lastLook: { hash: signIn.hash, changed: false }, timer: null, stopped: false }
  watches.set(key, watch)
  schedule(watch, firstLookMs)
}

/**
 * A sign-in step for the account went into its site (or a provider was
 * named for it): watch the site from the state before the step, and save
 * the account's session once it differs. Without a baseline (the site could
 * not be read before), nothing of this sign-in is saved, and a watch for an
 * earlier step on the site ends.
 */
export function watchSignIn(input: { agentSlug: string; sessionId: string; account: SessionAccount; baseline: SignInBaseline | null }): void {
  const { agentSlug, sessionId, account, baseline } = input
  if (!baseline || baseline.scope.site !== account.site) {
    endSignIn(agentSlug, sessionId, account.site)
    return
  }
  const signIn: SignIn = { agentSlug, sessionId, account, browserType: baseline.browserType, generation: baseline.generation, scope: baseline.scope, hash: baseline.hash }
  const now = Date.now()
  for (const [session, last] of lastSignIns) if (now - last.at > SIGN_IN_MEMORY_MS) lastSignIns.delete(session)
  lastSignIns.set(sessionKey(agentSlug, sessionId), { ...signIn, at: now })
  startWatch(signIn, FIRST_LOOK_MS)
}

/** What is on the site is no longer the last sign-in step's: its watch stops, and a hand-over no longer finishes it. */
function endSignIn(agentSlug: string, sessionId: string, site: string): void {
  const watch = watches.get(watchKey(agentSlug, sessionId, site))
  if (watch) stop(watch)
  const key = sessionKey(agentSlug, sessionId)
  if (lastSignIns.get(key)?.scope.site === site) lastSignIns.delete(key)
}

/** Whether a step is the provider step of a sign-in through it (`via`): that sign-in goes on. */
function continues(step: SignInStep, signIn: SignIn): boolean {
  const via = signIn.account.via
  if (!via) return false
  if (step.accountId !== null) return step.accountId === via.id
  return step.site === via.site && step.username !== null && usernameKey(step.username) === usernameKey(via.username)
}

/**
 * A sign-in step is about to go into the agent's browser (values filled, a
 * session restored, a provider named): what any site holds next may be that
 * sign-in's. Every sign-in being watched or remembered in the agent's
 * browser ends, in each of its sessions, but for those this is the provider
 * step of. The step's own account is watched again once it went in
 * (watchSignIn).
 */
export function beginSignInStep(agentSlug: string, step: SignInStep): void {
  for (const watch of [...watches.values()]) {
    if (watch.agentSlug === agentSlug && !continues(step, watch)) stop(watch)
  }
  for (const [key, last] of lastSignIns) {
    if (ofAgent(key, agentSlug) && !continues(step, last)) lastSignIns.delete(key)
  }
}

/** Someone other than the account's owner had the session's browser: none of its sign-ins goes on. */
function endSessionSignIns(agentSlug: string, sessionId: string): void {
  for (const watch of [...watches.values()]) {
    if (watch.agentSlug === agentSlug && watch.sessionId === sessionId) stop(watch)
  }
  lastSignIns.delete(sessionKey(agentSlug, sessionId))
}

/** The user has the session's browser: a hand-over or a sign-in card waits on them. */
async function userHasBrowser(agentSlug: string, sessionId: string): Promise<boolean> {
  const open = await agentRegistry.get(agentSlug).inputs.snapshot(sessionId)
  return open.some((request) => (request.kind === 'browser_input' || request.kind === 'login') && request.scope.sessionId === sessionId)
}

async function tick(watch: Watch): Promise<void> {
  if (watch.stopped) return
  let keepWatching = true
  try {
    keepWatching = await captureOnce(watch)
  } catch (error) {
    // The next poll tries again: a container restarting, a page between documents.
    console.error('[browser-vault] Saving a sign-in\'s session failed:', error instanceof Error ? error.message : error)
  }
  if (!keepWatching) {
    stop(watch)
    // Nor does a hand-over finish it: the browser it was in is gone.
    const key = sessionKey(watch.agentSlug, watch.sessionId)
    const last = lastSignIns.get(key)
    if (last?.account.id === watch.account.id && last.scope.site === watch.scope.site) lastSignIns.delete(key)
  } else if (Date.now() >= watch.until) {
    stop(watch)
  } else {
    schedule(watch, POLL_MS)
  }
}

/**
 * One look at the site's session, saved when it changed. False: stop
 * watching (the browser is gone, someone else's, another kind, or opened
 * again since the step).
 */
async function captureOnce(watch: Watch): Promise<boolean> {
  // Another kind of browser, or one opened again, is another browser: its state is not this sign-in's.
  const browser = await browserOf(watch.agentSlug, watch.sessionId)
  if (!browser || browser.type !== watch.browserType || browser.generation !== watch.generation) return false
  // What the user does in the browser is theirs to finish (watchAfterHandOver).
  if (await userHasBrowser(watch.agentSlug, watch.sessionId)) return true
  const response = await capture(watch.agentSlug, {
    sessionId: watch.sessionId,
    site: watch.scope.site,
    origin: watch.scope.origin,
    unlessHash: watch.hash,
  })
  // Closed or held by another session now (409), more than a saved session holds (413), a request the
  // browser refuses (400): none of it changes within the watch.
  if (response.status === 409 || response.status === 413 || response.status === 400) return false
  if (!response.ok) throw new Error(`the browser answered HTTP ${response.status}`)
  const result = captureResponseSchema.parse(await response.json())
  // Changing on look after look, to something new each time: a site that rewrites a cookie on every page.
  const churning = watch.lastLook.changed && result.hash !== watch.lastLook.hash
  watch.lastLook = { hash: result.hash, changed: result.bundle !== undefined }
  // Unchanged; or a newer step, a restore or a deletion ended the watch while it read.
  if (!result.bundle || watch.stopped) return !watch.stopped
  const now = Date.now()
  // Still changing: a later look saves it (once it holds still, or a minute on), and the last one in any case.
  if (churning && now < watch.until && watch.savedAt !== null && now - watch.savedAt < SAVE_EVERY_MS) return true
  await saveAccountSession({ agentSlug: watch.agentSlug, account: watch.account, browserType: watch.browserType, bundle: result.bundle })
  watch.hash = result.hash
  watch.savedAt = now
  const last = lastSignIns.get(sessionKey(watch.agentSlug, watch.sessionId))
  if (last?.account.id === watch.account.id) last.hash = result.hash
  return true
}

/**
 * The user had the browser and is done with it (a hand-over: a passkey, a
 * phone prompt that outlasted the wait; or signed in on the page in place of
 * the card), on the page of `site`; declined, with no site. Done on the site
 * of the session's last sign-in step, that site is looked at again, now, and
 * what changed since is saved. Only for the account's owner: someone else at
 * the browser signs in as themselves, and that is never saved to another
 * person's account, so their being done, or declining, ends the session's
 * sign-ins.
 */
export function watchAfterHandOver(input: { agentSlug: string; sessionId: string; viewer: string | null; site: string | null }): void {
  const { agentSlug, sessionId } = input
  const last = lastSignIns.get(sessionKey(agentSlug, sessionId))
  const signIns: SignIn[] = [...watches.values()].filter((watch) => watch.agentSlug === agentSlug && watch.sessionId === sessionId)
  if (last) signIns.push(last)
  if (signIns.some((signIn) => (signIn.account.ownerId ?? null) !== (input.viewer ?? null))) {
    endSessionSignIns(agentSlug, sessionId)
    return
  }
  if (!last || Date.now() - last.at > SIGN_IN_MEMORY_MS) return
  // Elsewhere (a CAPTCHA on another site), it finished nothing of the sign-in: a watch still running goes on.
  if (!input.site || registrableDomain(input.site) !== registrableDomain(last.scope.site)) return
  startWatch(last, 0)
}

/** Stop saving the account's sessions (from one agent's browser, with `agentSlug`): deleted, forgotten, or revoked. */
export function stopSessionWatches(accountId: string, agentSlug?: string): void {
  for (const watch of [...watches.values()]) {
    if (watch.account.id === accountId && (!agentSlug || watch.agentSlug === agentSlug)) stop(watch)
  }
  for (const [key, last] of lastSignIns) {
    if (last.account.id === accountId && (!agentSlug || key.startsWith(`${agentSlug}\u0000`))) lastSignIns.delete(key)
  }
}

/** Test seam. */
export function resetSessionWatches(): void {
  for (const watch of [...watches.values()]) stop(watch)
  lastSignIns.clear()
}
