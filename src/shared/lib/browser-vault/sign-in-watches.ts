import { z } from 'zod'
import type { ContainerOps, InputOps, SignInOps } from '@shared/lib/agent-actor/types'
import { background } from '@shared/lib/background'
import { getSettings } from '@shared/lib/config/settings'
import { saveAccountSession } from './session-service'
import { registrableDomain, usernameKey } from './site'
import { sessionBundleSchema, type BrowserType } from './vault-schemas'
import type { VaultAccount } from './vault-service'

/**
 * One agent's sign-in watches (session-host has the rules): a timer per
 * sign-in, in the agent's state. They run where the agent's actor runs, so
 * a watch started by an API request outlives that request.
 */

const browserStatusSchema = z.object({
  active: z.boolean(),
  sessionId: z.string().nullable(),
  location: z.enum(['host', 'container']).nullable(),
  generation: z.number().optional(),
}).loose()

/** The browser a session holds open: its type (sessions are kept by it), and which opening of it this is. */
export interface SessionBrowser {
  type: BrowserType
  generation: number | null
}

/** The browser the session holds open; null when it holds none. */
export async function browserOf(container: Pick<ContainerOps, 'fetch'>, sessionId: string): Promise<SessionBrowser | null> {
  const response = await container.fetch('/browser/status')
  if (!response.ok) return null
  const status = browserStatusSchema.safeParse(await response.json().catch(() => null))
  if (!status.success || !status.data.active || status.data.sessionId !== sessionId) return null
  const type = status.data.location === 'container' ? 'container' : status.data.location === 'host' ? (await getSettings()).app?.hostBrowserProvider ?? null : null
  return type ? { type, generation: status.data.generation ?? null } : null
}

export type SessionAccount = Pick<VaultAccount, 'id' | 'site' | 'origin' | 'ownerId' | 'via'>

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

/** The site's state just before a sign-in step went in: a capture is the step's only once it differs. */
export interface SignInBaseline {
  browserType: BrowserType
  generation: number | null
  scope: SessionScope
  hash: string
}

/** What a watch reaches of its agent: the container's browser, and the requests open on it. */
export interface SignInWatchReach {
  container: Pick<ContainerOps, 'fetch'>
  inputs: Pick<InputOps, 'snapshot'>
}

const WATCH_MS = 3 * 60_000
/** The first look after a step: the page has moved on by then, and the agent has not closed the browser yet. */
const FIRST_LOOK_MS = 2_000
const POLL_MS = 15_000
/** Saved at most this often while the site keeps changing (a site that rewrites a cookie on every page): the last state is saved when the watch ends. */
const SAVE_EVERY_MS = 60_000
/** How long a sign-in step's account is remembered for a hand-over that finishes it (as held values are kept). */
const SIGN_IN_MEMORY_MS = 30 * 60_000

export const captureResponseSchema = z.object({ hash: z.string(), bundle: sessionBundleSchema.optional() }).loose()

/** A sign-in being watched, or remembered for a hand-over: whose it is, where, and the state last seen as the account's. */
interface SignIn {
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
  reach: SignInWatchReach
  until: number
  savedAt: number | null
  /** The fingerprint the last look saw, and whether it differed from what was saved then. */
  lastLook: { hash: string; changed: boolean }
  timer: ReturnType<typeof setTimeout> | null
  stopped: boolean
}

const watchKey = (sessionId: string, site: string) => `${sessionId}\u0000${site}`

/** Whether a step is the provider step of a sign-in through it (`via`): that sign-in goes on. */
function continues(step: SignInStep, signIn: SignIn): boolean {
  const via = signIn.account.via
  if (!via) return false
  if (step.accountId !== null) return step.accountId === via.id
  return step.site === via.site && step.username !== null && usernameKey(step.username) === usernameKey(via.username)
}

export function captureRequest(reach: SignInWatchReach, body: Record<string, unknown>): Promise<Response> {
  return reach.container.fetch('/browser/session/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export class AgentSignInWatches {
  private readonly watches = new Map<string, Watch>()
  /** Each session's last sign-in, for a hand-over that finishes it. */
  private readonly lastSignIns = new Map<string, SignIn & { at: number }>()

  constructor(private readonly agentSlug: string) {}

  /**
   * A sign-in step for the account went into its site (or a provider was
   * named for it): watch the site from the state before the step, and save
   * the account's session once it differs. Without a baseline (the site could
   * not be read before), nothing of this sign-in is saved, and a watch for an
   * earlier step on the site ends.
   */
  watch(reach: SignInWatchReach, input: { sessionId: string; account: SessionAccount; baseline: SignInBaseline | null }): void {
    const { sessionId, account, baseline } = input
    if (!baseline || baseline.scope.site !== account.site) {
      this.endSignIn(sessionId, account.site)
      return
    }
    const signIn: SignIn = { sessionId, account, browserType: baseline.browserType, generation: baseline.generation, scope: baseline.scope, hash: baseline.hash }
    const now = Date.now()
    for (const [session, last] of this.lastSignIns) if (now - last.at > SIGN_IN_MEMORY_MS) this.lastSignIns.delete(session)
    this.lastSignIns.set(sessionId, { ...signIn, at: now })
    this.startWatch(reach, signIn, FIRST_LOOK_MS)
  }

  /**
   * A sign-in step is about to go into the agent's browser (values filled, a
   * session restored, a provider named): what any site holds next may be that
   * sign-in's. Every sign-in being watched or remembered in the agent's
   * browser ends, in each of its sessions, but for those this is the provider
   * step of. The step's own account is watched again once it went in (watch).
   */
  beginStep(step: SignInStep): void {
    for (const watch of [...this.watches.values()]) if (!continues(step, watch)) this.stop(watch)
    for (const [sessionId, last] of this.lastSignIns) if (!continues(step, last)) this.lastSignIns.delete(sessionId)
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
  afterHandOver(reach: SignInWatchReach, input: { sessionId: string; viewer: string | null; site: string | null }): void {
    const { sessionId } = input
    const last = this.lastSignIns.get(sessionId)
    const signIns: SignIn[] = [...this.watches.values()].filter((watch) => watch.sessionId === sessionId)
    if (last) signIns.push(last)
    if (signIns.some((signIn) => (signIn.account.ownerId ?? null) !== (input.viewer ?? null))) {
      this.endSessionSignIns(sessionId)
      return
    }
    if (!last || Date.now() - last.at > SIGN_IN_MEMORY_MS) return
    // Elsewhere (a CAPTCHA on another site), it finished nothing of the sign-in: a watch still running goes on.
    if (!input.site || registrableDomain(input.site) !== registrableDomain(last.scope.site)) return
    this.startWatch(reach, last, 0)
  }

  /** Stop saving the account's sessions from this agent's browser: deleted, forgotten, or revoked. */
  stopAccount(accountId: string): void {
    for (const watch of [...this.watches.values()]) if (watch.account.id === accountId) this.stop(watch)
    for (const [sessionId, last] of this.lastSignIns) if (last.account.id === accountId) this.lastSignIns.delete(sessionId)
  }

  /** The agent is gone from this process: every watch stops. */
  dispose(): void {
    for (const watch of [...this.watches.values()]) this.stop(watch)
    this.lastSignIns.clear()
  }

  private startWatch(reach: SignInWatchReach, signIn: SignIn, firstLookMs: number): void {
    const key = watchKey(signIn.sessionId, signIn.scope.site)
    const previous = this.watches.get(key)
    if (previous) this.stop(previous)
    const watch: Watch = { ...signIn, key, reach, until: Date.now() + WATCH_MS, savedAt: null, lastLook: { hash: signIn.hash, changed: false }, timer: null, stopped: false }
    this.watches.set(key, watch)
    this.schedule(watch, firstLookMs)
  }

  private stop(watch: Watch): void {
    watch.stopped = true
    if (watch.timer) clearTimeout(watch.timer)
    if (this.watches.get(watch.key) === watch) this.watches.delete(watch.key)
  }

  private schedule(watch: Watch, delayMs: number): void {
    if (watch.stopped) return
    watch.timer = setTimeout(() => {
      watch.timer = null
      background(() => this.tick(watch), { name: 'browser-vault.session-watch' })
    }, delayMs)
    watch.timer.unref?.()
  }

  /** What is on the site is no longer the last sign-in step's: its watch stops, and a hand-over no longer finishes it. */
  private endSignIn(sessionId: string, site: string): void {
    const watch = this.watches.get(watchKey(sessionId, site))
    if (watch) this.stop(watch)
    if (this.lastSignIns.get(sessionId)?.scope.site === site) this.lastSignIns.delete(sessionId)
  }

  /** Someone other than the account's owner had the session's browser: none of its sign-ins goes on. */
  private endSessionSignIns(sessionId: string): void {
    for (const watch of [...this.watches.values()]) if (watch.sessionId === sessionId) this.stop(watch)
    this.lastSignIns.delete(sessionId)
  }

  private async tick(watch: Watch): Promise<void> {
    if (watch.stopped) return
    let keepWatching = true
    try {
      keepWatching = await this.captureOnce(watch)
    } catch (error) {
      // The next poll tries again: a container restarting, a page between documents.
      console.error('[browser-vault] Saving a sign-in\'s session failed:', error instanceof Error ? error.message : error)
    }
    if (!keepWatching) {
      this.stop(watch)
      // Nor does a hand-over finish it: the browser it was in is gone.
      const last = this.lastSignIns.get(watch.sessionId)
      if (last?.account.id === watch.account.id && last.scope.site === watch.scope.site) this.lastSignIns.delete(watch.sessionId)
    } else if (Date.now() >= watch.until) {
      this.stop(watch)
    } else {
      this.schedule(watch, POLL_MS)
    }
  }

  /**
   * One look at the site's session, saved when it changed. False: stop
   * watching (the browser is gone, someone else's, another kind, or opened
   * again since the step).
   */
  private async captureOnce(watch: Watch): Promise<boolean> {
    // Another kind of browser, or one opened again, is another browser: its state is not this sign-in's.
    const browser = await browserOf(watch.reach.container, watch.sessionId)
    if (!browser || browser.type !== watch.browserType || browser.generation !== watch.generation) return false
    // What the user does in the browser is theirs to finish (afterHandOver).
    const open = await watch.reach.inputs.snapshot(watch.sessionId)
    if (open.some((request) => (request.kind === 'browser_input' || request.kind === 'login') && request.scope.sessionId === watch.sessionId)) return true
    const response = await captureRequest(watch.reach, {
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
    await saveAccountSession({ agentSlug: this.agentSlug, account: watch.account, browserType: watch.browserType, bundle: result.bundle })
    watch.hash = result.hash
    watch.savedAt = now
    const last = this.lastSignIns.get(watch.sessionId)
    if (last?.account.id === watch.account.id) last.hash = result.hash
    return true
  }
}

/** The actor's `signIns` group over the agent's watches, which reach its browser through `reach`. */
export function signInOps(watches: AgentSignInWatches, reach: SignInWatchReach): SignInOps {
  return {
    beginStep: async (step) => watches.beginStep(step),
    watch: async (input) => watches.watch(reach, input),
    afterHandOver: async (input) => watches.afterHandOver(reach, input),
    stopAccount: async (accountId) => watches.stopAccount(accountId),
  }
}
