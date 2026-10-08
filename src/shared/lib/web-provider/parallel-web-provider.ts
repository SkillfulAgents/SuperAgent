import { APP_VERSION } from '../config/version'
import { parseMcpResponse } from '../mcp/discover-tools'
import { isUrlAllowed } from './allowed-sites'
import { BaseWebProvider } from './base-web-provider'
import {
  ParallelInitializeSchema,
  ParallelRpcResponseSchema,
  ParallelSearchResponseSchema,
  ParallelToolResultSchema,
  ParallelToolsSchema,
} from './parallel-response-schema'
import type { WebProviderId, WebSearchOptions, WebSearchResponse } from './types'

const MCP_URL = 'https://search.parallel.ai/mcp'
const PROTOCOL_VERSION = '2025-03-26'
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

/** An agent-requested domain covers that host and its subdomains (`python.org` keeps `docs.python.org`). */
function withSubdomains(domains: string[] | undefined): string[] | undefined {
  return domains?.flatMap((domain) => (domain.startsWith('*.') ? [domain] : [domain, `*.${domain}`]))
}

/** Opt-in anonymous Search MCP. No saved key or inherited credential is consulted. */
export class ParallelWebProvider extends BaseWebProvider {
  readonly id: WebProviderId = 'parallel'
  readonly name = 'Parallel'
  protected readonly settingsKeyField = undefined
  protected readonly envVarName = undefined

  async validateKey(): Promise<{ valid: boolean; error?: string }> {
    return { valid: false, error: 'Parallel Search MCP does not require an API key.' }
  }

  async search(query: string, opts: WebSearchOptions): Promise<WebSearchResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': `Gamut/${APP_VERSION}`,
    }
    let sessionId: string | null = null
    const rpc = async (id: number, method: string, params?: Record<string, unknown>) => {
      const raw = await this.fetchJson(MCP_URL, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
      }, async (res) => {
        if (method === 'initialize') {
          sessionId = res.headers.get('Mcp-Session-Id')
          if (sessionId) headers['Mcp-Session-Id'] = sessionId
        }
        return parseMcpResponse(res)
      })
      const response = ParallelRpcResponseSchema.parse(raw)
      if (response.id !== id) throw new Error('Parallel returned a mismatched MCP response')
      if (response.error) throw new Error(`Parallel MCP error (${response.error.code})`)
      return response.result
    }

    try {
      ParallelInitializeSchema.parse(await rpc(1, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {}, clientInfo: { name: 'Gamut', version: APP_VERSION },
      }))
      headers['MCP-Protocol-Version'] = PROTOCOL_VERSION
      if (sessionId) headers['Mcp-Session-Id'] = sessionId
      await this.fetchJson(MCP_URL, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }, async (res) => { await res.body?.cancel(); return undefined })
      const tools = ParallelToolsSchema.parse(await rpc(2, 'tools/list'))
      if (!tools.tools.some((tool) => tool.name === 'web_search')) {
        throw new Error('Parallel Search MCP did not advertise web_search')
      }
      const constraints = [
        opts.includeDomains?.length ? `Only include domains: ${opts.includeDomains.join(', ')}.` : '',
        opts.excludeDomains?.length ? `Exclude domains: ${opts.excludeDomains.join(', ')}.` : '',
        opts.startPublishedDate ? `Published on or after ${opts.startPublishedDate}.` : '',
        opts.endPublishedDate ? `Published on or before ${opts.endPublishedDate}.` : '',
      ].filter(Boolean)
      const toolResult = ParallelToolResultSchema.parse(await rpc(3, 'tools/call', {
        name: 'web_search',
        arguments: { objective: [query, ...constraints].join('\n'), search_queries: [query] },
      }))
      if (toolResult.isError) throw new Error('Parallel Search MCP search failed')
      const text = toolResult.content.find((part) => part.type === 'text' && part.text)?.text
      const parsed = ParallelSearchResponseSchema.parse(
        toolResult.structuredContent ?? (text ? JSON.parse(text) : undefined),
      )
      const warnings = parsed.warnings?.map((warning) => warning.message) ?? []
      const start = opts.startPublishedDate ? Date.parse(opts.startPublishedDate) : undefined
      // A date-only end date covers that whole day, not just its first millisecond.
      const end = opts.endPublishedDate
        ? Date.parse(opts.endPublishedDate) + (DATE_ONLY.test(opts.endPublishedDate) ? DAY_MS - 1 : 0)
        : undefined
      if ((start !== undefined && !Number.isFinite(start)) || (end !== undefined && !Number.isFinite(end))) {
        throw new Error('Invalid Parallel search publication date filter')
      }
      const hits = parsed.results.map((result) => ({
        url: result.url, title: result.title ?? null, snippet: result.excerpts.join('\n\n'),
        ...(result.publish_date ? { publishedDate: result.publish_date } : {}),
      }))
      const sitePolicy = {
        allowedSites: withSubdomains(opts.includeDomains),
        blockedSites: withSubdomains(opts.excludeDomains),
      }
      const filtered = hits.filter((hit) => {
        if (!isUrlAllowed(hit.url, sitePolicy)) return false
        // Undated results are kept: only a known publication date outside the range removes a hit.
        const published = hit.publishedDate ? Date.parse(hit.publishedDate) : NaN
        if (!Number.isFinite(published)) return true
        return (start === undefined || published >= start) && (end === undefined || published <= end)
      })
      if (filtered.length < hits.length) warnings.push('Results outside the requested domain or publication date filters were removed.')
      return { hits: filtered.slice(0, this.clampNumResults(opts.numResults)), ...(warnings.length ? { warnings } : {}) }
    } finally {
      // A fresh session per search avoids stale shared state and releases server-side resources.
      if (sessionId) {
        await this.fetchJson(MCP_URL, { method: 'DELETE', headers }, async (res) => {
          await res.body?.cancel(); return undefined
        }).catch(() => undefined)
      }
    }
  }
}
