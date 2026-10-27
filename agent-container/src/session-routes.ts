/**
 * The container endpoints behind saved sessions (browser-session.ts): the
 * host reads an account's session out of the browser after a sign-in, and
 * writes one back when the agent signs in with an account that has one. A
 * session is as good as a password, so both answer only the host, and
 * neither ever logs or echoes what it carries.
 *
 * Everything that touches the live browser comes in through `SessionRouteDeps`.
 */
import type { Hono } from 'hono'
import { z } from 'zod'
import type { CdpConnection } from './login-cdp'
import { captureSession, originInScope, restoreSession, SessionRestoreError, SessionTooLargeError } from './browser-session'
import { sessionBundleSchema, sessionOriginSchema, sessionSiteSchema } from './browser-session-schema'

export interface SessionRouteDeps {
  hostAuthEnabled(): boolean
  /** Null when the session may use the browser, else why not. */
  validateSession(sessionId: string): string | null
  browserActive(): boolean
  /** A connection to the browser itself, not a page. */
  connectBrowser(): Promise<CdpConnection>
  /** The CDP target id of agent-browser's active tab: the one the agent works in. */
  activeTabId(): Promise<string | null>
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
  /** The fingerprint of the cookies of the last capture: unchanged, nothing more is read. */
  unlessCookieHash: z.string().max(100).optional(),
}).strict().refine(inScope)

const restoreRequestSchema = z.object({ ...scopeFields, bundle: sessionBundleSchema }).strict()
  .refine(inScope)
  .refine(({ site, bundle }) => bundle.site === site)

export function registerSessionRoutes(app: Hono, deps: SessionRouteDeps): void {
  /** One session operation on the browser at a time: two restores must not interleave their writes. */
  let busy: Promise<unknown> = Promise.resolve()
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = busy.then(work, work)
    busy = run.catch(() => {})
    return run
  }

  /** Why the request cannot run on the browser now, if it cannot. */
  const refusal = (sessionId: string): string | null =>
    deps.validateSession(sessionId) ?? (deps.browserActive() ? null : 'no browser is open')

  // POST /browser/session/capture - read the site's session out of the browser
  app.post('/browser/session/capture', async (c) => {
    if (!deps.hostAuthEnabled()) return c.json({ error: 'Host authentication is required' }, 503)
    c.header('Cache-Control', 'no-store')
    const parsed = captureRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid session request' }, 400)
    const { sessionId, site, origin, unlessCookieHash } = parsed.data
    const refused = refusal(sessionId)
    if (refused) return c.json({ error: refused }, 409)
    try {
      const result = await serially(async () => {
        const cdp = await deps.connectBrowser()
        try {
          return await captureSession(cdp, { site, origin }, { unlessCookieHash })
        } finally {
          cdp.close()
        }
      })
      if (!result.unchanged) {
        const { bundle } = result
        const lossy = result.unsupported.length > 0 || bundle.leftOut ? ' (some of it could not be kept)' : ''
        console.log(`[Session] Captured ${site}: ${bundle.cookies.length} cookie(s), ${bundle.origins.length} origin(s)${lossy}`)
      }
      return c.json(result)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error'
      console.error(`[Session] Capturing ${site} failed: ${reason}`)
      return c.json({ error: `The session could not be read: ${reason}` }, error instanceof SessionTooLargeError ? 413 : 500)
    }
  })

  // POST /browser/session/restore - write a saved session into the browser, in the agent's tab's place
  app.post('/browser/session/restore', async (c) => {
    if (!deps.hostAuthEnabled()) return c.json({ error: 'Host authentication is required' }, 503)
    c.header('Cache-Control', 'no-store')
    // Never echo the body or its parse issues: they carry the session.
    const parsed = restoreRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid session request' }, 400)
    const { sessionId, site, origin, bundle } = parsed.data
    const refused = refusal(sessionId)
    if (refused) return c.json({ error: refused, touched: false, cleared: false }, 409)
    try {
      const outcome = await serially(async () => {
        const tabId = await deps.activeTabId()
        if (!tabId) throw new SessionRestoreError('no browser page is open', false, false)
        const cdp = await deps.connectBrowser()
        try {
          return await restoreSession(cdp, { site, origin }, bundle, tabId)
        } finally {
          cdp.close()
          deps.pageReplaced()
        }
      })
      const digest = await deps.observeUrl().catch(() => null)
      console.log(`[Session] Restored ${site}${outcome.skippedRecords ? ` (${outcome.skippedRecords} record(s) left out)` : ''}`)
      return c.json({
        restored: true,
        skippedRecords: outcome.skippedRecords,
        cookieHash: outcome.cookieHash,
        ...(digest ? { observation: { digest } } : {}),
      })
    } catch (error) {
      // restoreSession says what it changed; anything else failed before it ran.
      const failure = error instanceof SessionRestoreError ? error : new SessionRestoreError(error instanceof Error ? error.message : 'unknown error', false, false)
      console.error(`[Session] Restoring ${site} failed: ${failure.message}${failure.touched ? (failure.cleared ? '; the site was emptied' : '; the site could not be emptied') : ''}`)
      return c.json({ error: `The saved session could not be restored: ${failure.message}`, touched: failure.touched, cleared: failure.cleared }, 500)
    }
  })
}
