import { Hono } from 'hono'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { getActiveWebFetchProvider } from '@shared/lib/web-provider'
import { isUrlAllowed } from '@shared/lib/web-provider/allowed-sites'
import { WebFetchRequestSchema } from '@shared/lib/web-provider/web-fetch-request-schema'
import { getSettings } from '@shared/lib/config/settings'
import { captureException } from '@shared/lib/error-reporting'

// Host-side defense-in-depth bound: adapters can cap content via maxChars, but a misbehaving vendor
// could ignore that or return an oversized document, so the host re-caps before it reaches the
// agent's context window. Larger than search's snippet cap because a fetch returns a full page.
const MAX_CONTENT_CHARS = 100_000

const webFetch = new Hono()

// Own proxy-token gate. The local-mode-auth bypass for this container-facing route only skips the
// IP check; it does NOT authenticate, and nothing is inherited from sibling routers — so this
// router must declare its own gate or it ships open (design §4 auth must-do).
webFetch.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  if (!(await validateProxyToken(token))) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

// POST /fetch — fetch one URL's content via the active vendor, enforcing the operator allow/deny
// policy on the TARGET host BEFORE dispatch. The host's only egress is the fixed vendor host
// (api.exa.ai fetches the target server-side), so the internal-range DNS/SSRF guard does not apply
// to the Exa reference and is deferred until a direct/in-container fetch backend lands (design §SSRF).
webFetch.post('/fetch', async (c) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = WebFetchRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', detail: parsed.error.issues }, 400)
  }

  const provider = getActiveWebFetchProvider()
  if (!provider) {
    return c.json({ error: 'No web fetch vendor configured' }, 400)
  }

  const { url, ...opts } = parsed.data
  const settings = getSettings()
  if (!isUrlAllowed(url, { allowedSites: settings.webAllowedSites, blockedSites: settings.webBlockedSites })) {
    return c.json({ error: 'This URL is blocked by your allowed-sites policy' }, 403)
  }

  try {
    const result = await provider.fetch(url, opts)
    const warnings: string[] = []
    if (result.content.length > MAX_CONTENT_CHARS) {
      result.content = result.content.slice(0, MAX_CONTENT_CHARS)
      warnings.push(`Content truncated to ${MAX_CONTENT_CHARS} characters.`)
    }
    // Log the host+path only (never the query string, which can carry sensitive params); this
    // [web-fetch] line fires only inside this route, so it is definitive proof the RPC reached Exa.
    let safeUrl: string
    try {
      const u = new URL(url)
      safeUrl = u.hostname + u.pathname
    } catch {
      safeUrl = 'invalid-url'
    }
    console.log(`[web-fetch] ${provider.id} fetched ${safeUrl} (${result.content.length} chars)`)
    return c.json({ result, ...(warnings.length > 0 ? { warnings } : {}) })
  } catch (err) {
    captureException(err, { tags: { component: 'web-fetch', operation: 'fetch' } })
    return c.json({ error: err instanceof Error ? err.message : 'Web fetch failed' }, 502)
  }
})

export default webFetch
