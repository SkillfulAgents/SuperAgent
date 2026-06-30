import { Hono } from 'hono'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { getActiveWebSearchProvider } from '@shared/lib/web-provider'
import { applyAllowedSites } from '@shared/lib/web-provider/allowed-sites'
import { WebSearchRequestSchema } from '@shared/lib/web-provider/web-search-request-schema'
import { getSettings } from '@shared/lib/config/settings'
import { captureException } from '@shared/lib/error-reporting'

type XAgentWebVariables = { callerSlug: string }

const xAgentWeb = new Hono<{ Variables: XAgentWebVariables }>()

// Own proxy-token gate. The /api/x-agent/ local-mode-auth bypass only skips the IP check; it
// does NOT authenticate, and nothing is inherited from sibling routers — so this router must
// declare its own gate or it ships open (design §4 auth must-do).
xAgentWeb.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const callerSlug = await validateProxyToken(token)
  if (!callerSlug) return c.json({ error: 'Unauthorized' }, 401)
  c.set('callerSlug', callerSlug)
  await next()
})

// POST /search — run the active vendor's search, enforce the operator allow/deny policy host-side.
xAgentWeb.post('/search', async (c) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = WebSearchRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', detail: parsed.error.issues }, 400)
  }

  const provider = getActiveWebSearchProvider()
  if (!provider) {
    return c.json({ error: 'No web search vendor configured' }, 400)
  }

  const { query, ...opts } = parsed.data
  try {
    const result = await provider.search(query, opts)
    const settings = getSettings()
    const { hits, removed } = applyAllowedSites(result.hits, {
      allowedSites: settings.webAllowedSites,
      blockedSites: settings.webBlockedSites,
    })
    const warnings = [...(result.warnings ?? [])]
    if (removed > 0) {
      warnings.push(`${removed} result${removed === 1 ? '' : 's'} removed by your allowed-sites policy`)
    }
    console.log(`[web-search] ${provider.id} returned ${hits.length} hits${removed > 0 ? ` (${removed} removed by policy)` : ''} for "${query}"`)
    return c.json({ hits, ...(warnings.length > 0 ? { warnings } : {}) })
  } catch (err) {
    captureException(err, { tags: { component: 'web-search', operation: 'search' } })
    return c.json({ error: err instanceof Error ? err.message : 'Web search failed' }, 502)
  }
})

export default xAgentWeb
