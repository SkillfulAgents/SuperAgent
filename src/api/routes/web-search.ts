import { Hono } from 'hono'
import { IsAgent } from '../middleware/auth'
import { getActiveWebProvider } from '@shared/lib/web-provider'
import { applyAllowedSites } from '@shared/lib/web-provider/allowed-sites'
import { WebSearchRequestSchema } from '@shared/lib/web-provider/web-search-request-schema'
import { getSettings } from '@shared/lib/config/settings'
import { captureException } from '@shared/lib/error-reporting'

// Host-side defense-in-depth bounds: adapters already clamp numResults to <=25, but a misbehaving
// vendor could ignore that or return oversized snippets, so the host re-caps before results reach
// the agent's context window.
const HARD_MAX_HITS = 50
const MAX_SNIPPET_CHARS = 2000

const webSearch = new Hono()

// IsAgent: proxy-token gate + agent-owner attribution scope for billed proxy calls.
webSearch.use('*', IsAgent())

// POST /search — run the active vendor's search, enforce the operator allow/deny policy host-side.
webSearch.post('/search', async (c) => {
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

  const provider = getActiveWebProvider()
  if (!provider?.search) {
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
    const cappedHits = hits.slice(0, HARD_MAX_HITS).map((h) =>
      h.snippet.length > MAX_SNIPPET_CHARS ? { ...h, snippet: h.snippet.slice(0, MAX_SNIPPET_CHARS) } : h,
    )
    if (hits.length > HARD_MAX_HITS) {
      warnings.push(`Showing the first ${HARD_MAX_HITS} of ${hits.length} results.`)
    }
    // Sanitize the agent-supplied query before logging: collapse whitespace (kills log forging via
    // newlines) and truncate (avoids dumping long/sensitive queries to host logs).
    const safeQuery = query.replace(/\s+/g, ' ').slice(0, 200)
    console.log(`[web-search] ${provider.id} returned ${cappedHits.length} hits${removed > 0 ? ` (${removed} removed by policy)` : ''} for "${safeQuery}"`)
    return c.json({ hits: cappedHits, ...(warnings.length > 0 ? { warnings } : {}) })
  } catch (err) {
    captureException(err, { tags: { component: 'web-search', operation: 'search' } })
    return c.json({ error: err instanceof Error ? err.message : 'Web search failed' }, 502)
  }
})

export default webSearch
