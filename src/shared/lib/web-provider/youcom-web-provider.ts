import type { ApiKeySettings } from '../config/settings'
import { APP_VERSION } from '../config/version'
import { parseMcpResponse } from '../mcp/discover-tools'
import { isUrlAllowed } from './allowed-sites'
import { BaseWebProvider } from './base-web-provider'
import {
  YouComInitializeSchema,
  YouComRpcResponseSchema,
  YouComSearchResponseSchema,
  YouComToolResultSchema,
  YouComToolsSchema,
} from './youcom-response-schema'
import type { WebProviderId, WebSearchOptions, WebSearchResponse } from './types'

const MCP_URL_FREE = 'https://api.you.com/mcp?profile=free'
const MCP_URL_KEYED = 'https://api.you.com/mcp'
const TOOL_NAME = 'you-search'
const PROTOCOL_VERSION = '2025-03-26'
const USER_AGENT = 'youdotcom-integration/SkillfulAgents-Gamut'
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

/** An agent-requested domain covers that host and its subdomains (`python.org` keeps `docs.python.org`). */
function withSubdomains(domains: string[] | undefined): string[] | undefined {
  return domains?.flatMap((domain) => (domain.startsWith('*.') ? [domain] : [domain, `*.${domain}`]))
}

function snippetFrom(hit: { description?: string | null; snippets?: string[] }): string {
  if (hit.snippets?.length) return hit.snippets.join('\n\n')
  return hit.description ?? ''
}

/**
 * Opt-in You.com Search MCP. Works without a key on the free profile (about
 * 100 searches a day). A saved or env `YDC_API_KEY` is an optional upgrade
 * to the authenticated endpoint. Existing defaults are unchanged.
 */
export class YouComWebProvider extends BaseWebProvider {
  readonly id: WebProviderId = 'youcom'
  readonly name = 'You.com'
  protected readonly settingsKeyField: keyof ApiKeySettings = 'ydcApiKey'
  protected readonly envVarName = 'YDC_API_KEY'

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    return this.runValidation((signal) =>
      fetch(MCP_URL_KEYED, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'Gamut', version: APP_VERSION },
          },
        }),
        signal,
      }),
    )
  }

  async search(query: string, opts: WebSearchOptions): Promise<WebSearchResponse> {
    const apiKey = await this.getEffectiveApiKey()
    const mcpUrl = apiKey ? MCP_URL_KEYED : MCP_URL_FREE
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': USER_AGENT,
    }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    let sessionId: string | null = null
    const rpc = async (id: number, method: string, params?: Record<string, unknown>) => {
      const raw = await this.fetchJson(mcpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
      }, async (res) => {
        if (method === 'initialize') {
          sessionId = res.headers.get('Mcp-Session-Id')
          if (sessionId) headers['Mcp-Session-Id'] = sessionId
        }
        return parseMcpResponse(res)
      })
      const response = YouComRpcResponseSchema.parse(raw)
      if (response.id !== id) throw new Error('You.com returned a mismatched MCP response')
      if (response.error) throw new Error(`You.com MCP error (${response.error.code})`)
      return response.result
    }

    try {
      YouComInitializeSchema.parse(await rpc(1, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Gamut', version: APP_VERSION },
      }))
      headers['MCP-Protocol-Version'] = PROTOCOL_VERSION
      if (sessionId) headers['Mcp-Session-Id'] = sessionId
      await this.fetchJson(mcpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }, async (res) => { await res.body?.cancel(); return undefined })
      const tools = YouComToolsSchema.parse(await rpc(2, 'tools/list'))
      if (!tools.tools.some((tool) => tool.name === TOOL_NAME)) {
        throw new Error('You.com MCP did not advertise you-search')
      }
      const count = this.clampNumResults(opts.numResults)
      // Domain and date constraints are enforced on returned hits. include/exclude
      // are not sent as API domain-filter parameters.
      const toolResult = YouComToolResultSchema.parse(await rpc(3, 'tools/call', {
        name: TOOL_NAME,
        arguments: { query, count, extraction: 'highlights' },
      }))
      if (toolResult.isError) throw new Error('You.com MCP search failed')
      const text = toolResult.content.find((part) => part.type === 'text' && part.text)?.text
      const parsed = YouComSearchResponseSchema.parse(
        toolResult.structuredContent ?? (text ? JSON.parse(text) : undefined),
      )
      const rawHits = [
        ...(parsed.results?.web ?? []),
        ...(parsed.results?.news ?? []),
      ]
      const warnings: string[] = []
      const start = opts.startPublishedDate ? Date.parse(opts.startPublishedDate) : undefined
      const end = opts.endPublishedDate
        ? Date.parse(opts.endPublishedDate) + (DATE_ONLY.test(opts.endPublishedDate) ? DAY_MS - 1 : 0)
        : undefined
      if ((start !== undefined && !Number.isFinite(start)) || (end !== undefined && !Number.isFinite(end))) {
        throw new Error('Invalid You.com search publication date filter')
      }
      const hits = rawHits.map((result) => ({
        url: result.url,
        title: result.title ?? null,
        snippet: snippetFrom(result),
        ...(result.published_date ? { publishedDate: result.published_date } : {}),
        ...(result.favicon_url ? { favicon: result.favicon_url } : {}),
      }))
      const sitePolicy = {
        allowedSites: withSubdomains(opts.includeDomains),
        blockedSites: withSubdomains(opts.excludeDomains),
      }
      const filtered = hits.filter((hit) => {
        if (!isUrlAllowed(hit.url, sitePolicy)) return false
        const published = hit.publishedDate ? Date.parse(hit.publishedDate) : NaN
        if (!Number.isFinite(published)) return true
        return (start === undefined || published >= start) && (end === undefined || published <= end)
      })
      if (filtered.length < hits.length) {
        warnings.push('Results outside the requested domain or publication date filters were removed.')
      }
      return { hits: filtered.slice(0, count), ...(warnings.length ? { warnings } : {}) }
    } finally {
      if (sessionId) {
        await this.fetchJson(mcpUrl, { method: 'DELETE', headers }, async (res) => {
          await res.body?.cancel(); return undefined
        }).catch(() => undefined)
      }
    }
  }
}
