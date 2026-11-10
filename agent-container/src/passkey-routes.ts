/**
 * The container endpoints behind the vault's passkeys (the host calls them;
 * the agent never does): hold an account's passkeys on the agent's tab for a
 * sign-in, or record the one a site creates while the agent adds one, and
 * hand that one to the host. A private key goes only to the host, over its
 * own channel. See passkey-keeper.ts.
 */
import type { Hono } from 'hono'
import { z } from 'zod'
import { elementRefSchema } from './login-schema'
import type { PasskeyKeeper } from './passkey-keeper'

export interface PasskeyRouteDeps {
  hostAuthEnabled(): boolean
  validateSession(sessionId: string): string | null
  browserActive(): boolean
  keeper: PasskeyKeeper
  /** The tab the agent's refs belong to, and the origin of its page. */
  activeTab(): Promise<{ id: string; url: string } | null>
  /** Click a ref the agent named, as its own click would: the CLI's error text, or null. */
  click(ref: string): Promise<string | null>
}

const credentialSchema = z.object({
  credentialId: z.string().min(1).max(1024),
  rpId: z.string().min(1).max(253),
  privateKey: z.string().min(1).max(8192),
  userHandle: z.string().max(1024).optional(),
  signCount: z.number().int().min(0),
  userName: z.string().max(320).optional(),
  userDisplayName: z.string().max(320).optional(),
}).strict()

const armSchema = z.object({
  sessionId: z.string().min(1).max(1024),
  mode: z.enum(['present', 'record']),
  credentials: z.array(credentialSchema).max(20).default([]),
  ttlMs: z.number().int().min(1_000).max(30 * 60_000),
  /** Recording on this tab already: go on, rather than start over. */
  keep: z.boolean().optional(),
  /** After arming, click this (the site's "Add a passkey"). */
  clickRef: elementRefSchema.optional(),
}).strict()

const takeSchema = z.object({ waitMs: z.number().int().min(0).max(120_000) }).strict()

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

export function registerPasskeyRoutes(app: Hono, deps: PasskeyRouteDeps): void {
  // POST /browser/passkey/arm - hold passkeys on the agent's tab, or record what it creates
  app.post('/browser/passkey/arm', async (c) => {
    if (!deps.hostAuthEnabled()) return c.json({ error: 'Host authentication is required' }, 503)
    // Never echo the body or its parse issues: they carry private keys.
    const parsed = armSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid passkey request' }, 400)
    const body = parsed.data
    const sessionError = deps.validateSession(body.sessionId)
    if (sessionError) return c.json({ error: sessionError }, 409)
    if (!deps.browserActive()) return c.json({ error: 'No browser is open', reason: 'browser_closed' }, 409)
    const tab = await deps.activeTab()
    const origin = tab ? originOf(tab.url) : null
    if (!tab || !origin) return c.json({ error: 'The browser shows no web page' }, 409)
    try {
      await deps.keeper.arm({ targetId: tab.id, mode: body.mode, credentials: body.credentials, ttlMs: body.ttlMs, keep: body.keep })
    } catch (error) {
      console.error('[Browser] Arming passkeys failed:', error instanceof Error ? error.message : 'Unknown error')
      return c.json({ error: 'The browser could not hold passkeys' }, 500)
    }
    let clickError: string | null = null
    if (body.clickRef) clickError = await deps.click(body.clickRef)
    return c.json({ armed: true, origin, ...(clickError ? { clickError } : {}) })
  })

  // POST /browser/passkey/created - the passkey the page created since arming (record), once
  app.post('/browser/passkey/created', async (c) => {
    if (!deps.hostAuthEnabled()) return c.json({ error: 'Host authentication is required' }, 503)
    const parsed = takeSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid passkey request' }, 400)
    const credential = await deps.keeper.takeCreated(parsed.data.waitMs)
    c.header('Cache-Control', 'no-store')
    return c.json({ credential })
  })

  // POST /browser/passkey/disarm - let go of the tab: the passkeys leave the browser
  app.post('/browser/passkey/disarm', async (c) => {
    if (!deps.hostAuthEnabled()) return c.json({ error: 'Host authentication is required' }, 503)
    await deps.keeper.disarm()
    return c.json({ disarmed: true })
  })

  // GET /browser/passkey/state - what the tab holds now (ids only), what the page used, and whether it is the agent's tab still
  app.get('/browser/passkey/state', async (c) => {
    if (!deps.hostAuthEnabled()) return c.json({ error: 'Host authentication is required' }, 503)
    const state = deps.keeper.state()
    // The agent may have gone on in another tab (a window the site opened): nothing is held there.
    const tab = state.armed ? await deps.activeTab().catch(() => null) : null
    return c.json({ ...state, onActiveTab: tab !== null && tab.id === state.targetId })
  })
}
