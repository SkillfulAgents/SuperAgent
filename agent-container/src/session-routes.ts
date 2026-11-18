/**
 * The container endpoints behind saved sessions (browser-session.ts): the
 * host reads the site's session out of the browser around a sign-in, and
 * writes one back when the agent signs in with an account that has one. A
 * session is as good as a password, so both answer only the host, and
 * neither ever logs or echoes what it carries.
 *
 * Everything that touches the live browser comes in through `SessionRouteDeps`.
 */
import type { Hono } from 'hono'
import { z } from 'zod'
import type { CdpConnection } from './login-cdp'
import { browserAlone } from './browser-gate'
import {
  captureSession,
  originInScope,
  restoreSession,
  SessionRestoreError,
  SessionTooLargeError,
  type CaptureResult,
  type OutsideCookie,
} from './browser-session'
import { sessionBundleSchema, sessionOriginSchema, sessionSiteSchema } from './browser-session-schema'
import { describeOutside } from './session-outside'

export interface SessionRouteDeps {
  hostAuthEnabled(): boolean
  /** Null when the session may use the browser, else why not. */
  validateSession(sessionId: string): string | null
  browserActive(): boolean
  /** A connection to the browser itself, not a page. */
  connectBrowser(): Promise<CdpConnection>
  /** The CDP target id of agent-browser's active tab: the one the agent works in. */
  activeTabId(): Promise<string | null>
  /** Run an operation with agent-browser kept on that tab: the operation opens tabs of its own, which it would follow. */
  keepActiveTab<T>(work: () => Promise<T>): Promise<T>
  /** The address bar's URL digest now. */
  observeUrl(): Promise<Record<string, unknown> | null>
  /** The agent's tab loaded another document under the CLI: what is kept about the old one goes. */
  pageReplaced(): void
}

const scopeFields = {
  sessionId: z.string().min(1).max(200),
  site: sessionSiteSchema,
  /** Where the account's sign-in page was: its storage is read even with no cookie or tab pointing there. */
  origin: sessionOriginSchema,
}
const inScope = ({ site, origin }: { site: string; origin: string }) => originInScope(origin, site)

const captureRequestSchema = z.object({
  ...scopeFields,
  /** The fingerprint the host last saw: a session that still has it comes back without its contents. */
  unlessHash: z.string().max(100).optional(),
  /** Only the fingerprint: the state before a sign-in step, for later captures to be compared with. */
  peek: z.boolean().optional(),
}).strict().refine(inScope)

const restoreRequestSchema = z.object({ ...scopeFields, bundle: sessionBundleSchema }).strict()
  .refine(inScope)
  .refine(({ site, bundle }) => bundle.site === site)

/** The browser stopped being the session's while the request waited its turn. */
class BrowserTakenError extends Error {}

/** Sign-ins whose outside cookies are kept to compare with: the latest. */
const OUTSIDE_KEPT = 20

export function registerSessionRoutes(app: Hono, deps: SessionRouteDeps): void {
  /** Why the request cannot run on the browser now, if it cannot. */
  const refusal = (sessionId: string): string | null =>
    deps.validateSession(sessionId) ?? (deps.browserActive() ? null : 'no browser is open')

  /** Run alone in the browser (browser-gate.ts), still the session's when its turn comes, the agent kept on its tab. */
  const alone = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => browserAlone(async () => {
    const refused = refusal(sessionId)
    if (refused) throw new BrowserTakenError(refused)
    return deps.keepActiveTab(work)
  })

  /**
   * The cookies outside each watched site as they were right before its
   * last sign-in step (the host peeks then), and what was last logged of
   * the tab's site: the outside-the-scope log (session-outside.ts), once
   * per change there.
   */
  const outsideBefore = new Map<string, { cookies: OutsideCookie[]; logged: string | null }>()
  const noteOutside = (sessionId: string, site: string, result: CaptureResult, peek: boolean | undefined): void => {
    const key = `${sessionId}\u0000${site}`
    if (peek) {
      outsideBefore.delete(key)
      outsideBefore.set(key, { cookies: result.outside, logged: null })
      while (outsideBefore.size > OUTSIDE_KEPT) {
        const oldest = outsideBefore.keys().next().value
        if (oldest === undefined) break
        outsideBefore.delete(oldest)
      }
      return
    }
    const before = outsideBefore.get(key)
    const change = before ? describeOutside(before.cookies, result.outside, result.tabSite) : null
    if (!before || !change || change.onTab === before.logged) return
    before.logged = change.onTab
    console.log(`[Session] Outside ${site} since the sign-in step: ${change.onTab} · ${change.elsewhere}`)
  }

  // POST /browser/session/capture - read the site's session out of the browser
  app.post('/browser/session/capture', async (c) => {
    if (!deps.hostAuthEnabled()) return c.json({ error: 'Host authentication is required' }, 503)
    c.header('Cache-Control', 'no-store')
    const parsed = captureRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid session request' }, 400)
    const { sessionId, site, origin, unlessHash, peek } = parsed.data
    const refused = refusal(sessionId)
    if (refused) return c.json({ error: refused }, 409)
    try {
      // Asked before the turn: finding the agent's tab asks agent-browser, which waits for no operation to run.
      const tabId = await deps.activeTabId().catch(() => null)
      const result = await alone(sessionId, async () => {
        const cdp = await deps.connectBrowser()
        try {
          return await captureSession(cdp, { site, origin }, { unlessHash, peek, tabId })
        } finally {
          cdp.close()
        }
      })
      if (result.bundle) {
        const { bundle } = result
        const lossy = result.unsupported.length > 0 || bundle.leftOut ? ' (some of it could not be kept)' : ''
        console.log(`[Session] Captured ${site}: ${bundle.cookies.length} cookie(s), ${bundle.origins.length} origin(s)${lossy}`)
      }
      noteOutside(sessionId, site, result, peek)
      return c.json({ hash: result.hash, ...(result.bundle ? { bundle: result.bundle } : {}) })
    } catch (error) {
      if (error instanceof BrowserTakenError) return c.json({ error: error.message }, 409)
      const reason = error instanceof Error ? error.message : 'unknown error'
      console.error(`[Session] Capturing ${site} failed: ${reason}`)
      return c.json({ error: `The session could not be read: ${reason}` }, error instanceof SessionTooLargeError ? 413 : 500)
    }
  })

  // POST /browser/session/restore - write a saved session into the browser, in place of the site's state
  app.post('/browser/session/restore', async (c) => {
    if (!deps.hostAuthEnabled()) return c.json({ error: 'Host authentication is required' }, 503)
    c.header('Cache-Control', 'no-store')
    // Never echo the body or its parse issues: they carry the session.
    const parsed = restoreRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid session request' }, 400)
    const { sessionId, site, origin, bundle } = parsed.data
    const refused = refusal(sessionId)
    const untouched = { touched: false, changed: false, cleared: false }
    if (refused) return c.json({ error: refused, ...untouched }, 409)
    try {
      const tabId = await deps.activeTabId()
      if (!tabId) throw new SessionRestoreError('no browser page is open', false, false, false)
      const outcome = await alone(sessionId, async () => {
        const cdp = await deps.connectBrowser()
        try {
          return await restoreSession(cdp, { site, origin }, bundle, tabId)
        } finally {
          cdp.close()
          deps.pageReplaced()
        }
      })
      const digest = await deps.observeUrl().catch(() => null)
      const { settled } = outcome
      const settle = settled ? `; the tab settled ${(settled.waitedMs / 1000).toFixed(1)} s after loading${settled.movedTo ? `, gone on to ${settled.movedTo}` : ''}` : ''
      console.log(`[Session] Restored ${site}${outcome.skippedRecords ? ` (${outcome.skippedRecords} record(s) left out)` : ''}${settle}`)
      return c.json({ restored: true, skippedRecords: outcome.skippedRecords, ...(digest ? { observation: { digest } } : {}) })
    } catch (error) {
      if (error instanceof BrowserTakenError) return c.json({ error: error.message, ...untouched }, 409)
      // restoreSession says what it changed; anything else failed before it ran.
      const failure = error instanceof SessionRestoreError ? error : new SessionRestoreError(error instanceof Error ? error.message : 'unknown error', false, false, false)
      const state = failure.changed ? (failure.cleared ? '; the site was emptied' : '; the site could not be emptied') : ''
      console.error(`[Session] Restoring ${site} failed: ${failure.message}${state}`)
      const { touched, changed, cleared } = failure
      return c.json({ error: `The saved session could not be restored: ${failure.message}`, touched, changed, cleared }, 500)
    }
  })
}
