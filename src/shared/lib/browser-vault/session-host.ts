import { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import { background } from '@shared/lib/background'
import { getSettings } from '@shared/lib/config/settings'
import { heldAccountOnSite, heldSessionVersion, markSessionHeld, readAccountSession, saveAccountSession, type SavedSession } from './session-service'
import { siteOfOrigin } from './site'
import { sessionBundleSchema, type BrowserType } from './vault-schemas'
import { getAccount, recordAccountUse, type VaultAccount } from './vault-service'

/**
 * The host's side of saved sessions (the container's browser-session.ts
 * reads and writes them in the browser):
 *
 * - Restore: when the agent names an account to sign in with, a session
 *   saved from an earlier sign-in goes in first, in place of its values,
 *   unless the agent's browser already held that capture (then it did not
 *   sign the agent in, and the values fill).
 * - Sync: when the agent opens a page on a site where its browser holds one
 *   of its accounts, a later capture of that account (another agent signed
 *   in since) goes in before the agent uses the page. It can replace a
 *   session that still worked with one that does not (a sign-in that never
 *   finished); the agent then signs in again, and that is saved.
 * - Capture: after each sign-in step, the site's session is saved, and again
 *   each time its cookies change over the next three minutes: a phone prompt
 *   approved, a passkey in the user's hands, a provider's redirect landing
 *   back all complete a sign-in without another call. Each capture is saved
 *   to the account of the step that started the watch, and only then.
 *
 * Watches live in this process's memory, like held values.
 */

const browserStatusSchema = z.object({
  active: z.boolean(),
  sessionId: z.string().nullable(),
  location: z.enum(['host', 'container']).nullable(),
}).loose()

/** The type of the browser the session holds open, as sessions are kept by it; null when it holds none. */
export async function browserTypeOf(agentSlug: string, sessionId: string): Promise<BrowserType | null> {
  const response = await agentRegistry.get(agentSlug).container.fetch('/browser/status')
  if (!response.ok) return null
  const status = browserStatusSchema.safeParse(await response.json().catch(() => null))
  if (!status.success || !status.data.active || status.data.sessionId !== sessionId) return null
  if (status.data.location === 'container') return 'container'
  return status.data.location === 'host' ? getSettings().app?.hostBrowserProvider ?? null : null
}

type SessionAccount = Pick<VaultAccount, 'id' | 'site' | 'origin' | 'ownerId'>

// ── Restore ────────────────────────────────────────────────────────────────

/** How a restore ended, for the agent's tool result (the container's loginSessionReportSchema). */
export type SessionResolution = {
  type: 'session'
  site: string
  username: string
  restored: boolean
  cleared?: boolean
  observation?: Record<string, unknown>
}

const restoredSchema = z.object({
  restored: z.literal(true),
  cookieHash: z.string().optional(),
  observation: z.record(z.string(), z.unknown()).optional(),
}).loose()
const restoreFailureSchema = z.object({ touched: z.boolean(), cleared: z.boolean() }).loose()

/** Put a capture into the agent's browser in place of the site's state, and count it as held. */
async function restoreCapture(input: {
  agentSlug: string
  sessionId: string
  account: VaultAccount
  browserType: BrowserType
  saved: SavedSession
}): Promise<SessionResolution | null> {
  const { agentSlug, sessionId, account, browserType, saved } = input
  const response = await agentRegistry.get(agentSlug).container.fetch('/browser/session/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, site: account.site, origin: account.origin, bundle: saved.bundle }),
  })
  const data: unknown = await response.json().catch(() => null)
  const restored = response.ok ? restoredSchema.safeParse(data) : null
  if (restored?.success) {
    await markSessionHeld({ agentSlug, account, version: saved.version })
    await recordAccountUse({ agentSlug, accountId: account.id, sessionId, password: false, by: 'vault', session: true })
    // What the site hands out on first use (a token refreshed) is kept like a sign-in's.
    watchSignIn({ agentSlug, sessionId, account, browserType, cookieHash: restored.data.cookieHash })
    return {
      type: 'session',
      site: account.site,
      username: account.username,
      restored: true,
      ...(restored.data.observation ? { observation: restored.data.observation } : {}),
    }
  }
  // Failed before it changed the page: as if never tried. After: tried, and the site emptied (or not).
  const failure = restoreFailureSchema.safeParse(data)
  if (!failure.success || !failure.data.touched) return null
  await markSessionHeld({ agentSlug, account, version: saved.version })
  return { type: 'session', site: account.site, username: account.username, restored: false, cleared: failure.data.cleared }
}

/**
 * Sign the agent in with the account's saved session instead of its values,
 * when it has one for this browser that the browser has not held. Null: go
 * on and fill (no such session, or the restore failed before it changed the
 * page). A restore that changed the browser counts as tried either way: the
 * same capture never goes in twice, so the agent's next call fills.
 */
export async function restoreSavedSession(input: { agentSlug: string; sessionId: string; account: VaultAccount }): Promise<SessionResolution | null> {
  const { agentSlug, sessionId, account } = input
  try {
    const browserType = await browserTypeOf(agentSlug, sessionId)
    if (!browserType) return null
    const saved = await readAccountSession(account, browserType)
    if (!saved || (await heldSessionVersion(agentSlug, account.id)) === saved.version) return null
    return await restoreCapture({ agentSlug, sessionId, account, browserType, saved })
  } catch (error) {
    console.error('[browser-vault] Restoring a saved session failed:', error instanceof Error ? error.message : error)
    return null
  }
}

/** The site of a page's URL, as accounts are kept by it; null for anything but http(s). */
function siteOfUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? siteOfOrigin(parsed.origin) : null
  } catch {
    return null
  }
}

/**
 * The agent opened `url`: when its browser holds one of its accounts on that
 * site and the vault has a later capture of the same account (versions only
 * grow), put it in before the agent uses the page. Only that site, and only
 * the account the browser holds there: of several accounts on a site, which
 * one to use stays the agent's call. True when a session went in.
 */
export async function syncSessionOnOpen(input: { agentSlug: string; sessionId: string; url: string }): Promise<boolean> {
  const { agentSlug, sessionId, url } = input
  try {
    const site = siteOfUrl(url)
    const held = site ? await heldAccountOnSite(agentSlug, site) : null
    if (!held) return false
    const account = await getAccount(held.accountId)
    const browserType = account ? await browserTypeOf(agentSlug, sessionId) : null
    if (!account || !browserType) return false
    const saved = await readAccountSession(account, browserType)
    if (!saved || saved.version <= held.version) return false
    return (await restoreCapture({ agentSlug, sessionId, account, browserType, saved }))?.restored === true
  } catch (error) {
    console.error('[browser-vault] Syncing a saved session failed:', error instanceof Error ? error.message : error)
    return false
  }
}

// ── Capture ────────────────────────────────────────────────────────────────

const WATCH_MS = 3 * 60_000
const POLL_MS = 15_000
/** At most this many captures per watch: a site that rewrites its cookies on every request does not save one each poll. */
const MAX_CAPTURES = 5
/** How long a sign-in step's account is remembered for a hand-over that finishes it (as held values are kept). */
const SIGN_IN_MEMORY_MS = 30 * 60_000

const captureResponseSchema = z.union([
  z.object({ unchanged: z.literal(true), cookieHash: z.string() }).loose(),
  z.object({ unchanged: z.literal(false), cookieHash: z.string(), bundle: sessionBundleSchema }).loose(),
])

interface Watch {
  key: string
  agentSlug: string
  sessionId: string
  account: SessionAccount
  browserType: BrowserType | null
  /** The fingerprint of the site's cookies as last saved (or restored): unchanged, nothing is read. */
  cookieHash: string | undefined
  until: number
  captures: number
  timer: ReturnType<typeof setTimeout> | null
  stopped: boolean
}

const watches = new Map<string, Watch>()
/** The account of each session's last sign-in step, for a hand-over that finishes it. */
const lastSignIns = new Map<string, { account: SessionAccount; at: number }>()

const watchKey = (agentSlug: string, sessionId: string, site: string) => `${agentSlug}\u0000${sessionId}\u0000${site}`
const sessionKey = (agentSlug: string, sessionId: string) => `${agentSlug}\u0000${sessionId}`

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

/**
 * A sign-in step for the account went into its site (or a provider sends
 * the agent on to sign in there): save the site's session now, and again
 * each time the site's cookies change over the next three minutes. A newer
 * step on the same site replaces the watch; with `cookieHash` (a session
 * just restored), only a change is saved.
 */
export function watchSignIn(input: {
  agentSlug: string
  sessionId: string
  account: SessionAccount
  browserType?: BrowserType
  cookieHash?: string
}): void {
  const { agentSlug, sessionId, account } = input
  const key = watchKey(agentSlug, sessionId, account.site)
  const previous = watches.get(key)
  if (previous) stop(previous)
  const watch: Watch = {
    key,
    agentSlug,
    sessionId,
    account,
    browserType: input.browserType ?? null,
    cookieHash: input.cookieHash,
    until: Date.now() + WATCH_MS,
    captures: 0,
    timer: null,
    stopped: false,
  }
  watches.set(key, watch)
  const now = Date.now()
  for (const [session, last] of lastSignIns) if (now - last.at > SIGN_IN_MEMORY_MS) lastSignIns.delete(session)
  lastSignIns.set(sessionKey(agentSlug, sessionId), { account, at: now })
  schedule(watch, input.cookieHash ? POLL_MS : 0)
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
  if (!keepWatching || Date.now() >= watch.until || watch.captures >= MAX_CAPTURES) stop(watch)
  else schedule(watch, POLL_MS)
}

/** One look at the site's session, saved when it changed. False: stop watching (the browser is gone or someone else's). */
async function captureOnce(watch: Watch): Promise<boolean> {
  const browserType = watch.browserType ?? await browserTypeOf(watch.agentSlug, watch.sessionId)
  if (!browserType) return false
  watch.browserType = browserType
  const response = await agentRegistry.get(watch.agentSlug).container.fetch('/browser/session/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: watch.sessionId,
      site: watch.account.site,
      origin: watch.account.origin,
      ...(watch.cookieHash ? { unlessCookieHash: watch.cookieHash } : {}),
    }),
  })
  // Closed, or held by another session now: what is there is no longer this sign-in's.
  if (response.status === 409) return false
  // Bigger than a saved session holds: it will not get smaller in three minutes.
  if (response.status === 413) return false
  if (!response.ok) throw new Error(`the browser answered HTTP ${response.status}`)
  const result = captureResponseSchema.parse(await response.json())
  if (result.unchanged) return true
  // A newer step on the site started while this one read: its own watch saves.
  if (watch.stopped) return false
  await saveAccountSession({ agentSlug: watch.agentSlug, account: watch.account, browserType, bundle: result.bundle })
  watch.cookieHash = result.cookieHash
  watch.captures++
  return true
}

/**
 * The user finished a step in the browser by hand (a hand-over: a passkey, a
 * phone prompt that outlasted the wait): if it followed a sign-in step in
 * this session, watch its site again, for the session it may have completed.
 * Only for the account's owner: someone else at the browser signs in as
 * themselves, and that is not saved to another person's account.
 */
export function watchAfterHandOver(input: { agentSlug: string; sessionId: string; viewer: string | null }): void {
  const last = lastSignIns.get(sessionKey(input.agentSlug, input.sessionId))
  if (!last || Date.now() - last.at > SIGN_IN_MEMORY_MS) return
  if ((last.account.ownerId ?? null) !== (input.viewer ?? null)) return
  watchSignIn({ agentSlug: input.agentSlug, sessionId: input.sessionId, account: last.account })
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
