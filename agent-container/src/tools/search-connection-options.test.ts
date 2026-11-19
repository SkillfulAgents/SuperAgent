import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ tool: (name: string, description: string, _schema: unknown, handler: (args: { search?: string }) => Promise<unknown>) => ({ name, description, handler }) }))
import { searchConnectionOptionsTool } from './search-connection-options'

type Result = { content: Array<{ text: string }>; isError?: boolean }
const search = (term?: string) => (searchConnectionOptionsTool as unknown as { handler(args: { search?: string }): Promise<Result> }).handler({ search: term })

const slack = {
  service: 'slack', displayName: 'Slack', category: 'Communication',
  accounts: [
    { toolkit: 'slack', displayName: 'Slack', description: 'Team communication platform', assigned: 'active' },
    { toolkit: 'slackbot', displayName: 'Slack Bot', description: 'Workspace search and history with messaging as a Slack bot' },
  ],
  mcps: [],
  integrations: [{ provider: 'slack', name: 'Slack', guide: 'Required:\n- botToken' }],
  guidance: 'Talking with people as the agent → the integration.',
}

function hostReturns(body: unknown) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json(body))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

beforeEach(() => { vi.stubEnv('SUPERAGENT_HOST_API_URL', 'https://host/api'); vi.stubEnv('PROXY_TOKEN', 'token') })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('search_connection_options', () => {
  it('asks the host and shows a service\'s ways in together, with what the agent has and the guidance', async () => {
    const fetch = hostReturns({ total: 300, services: [slack] })
    const result = await search('slack')

    expect(fetch).toHaveBeenCalledWith('https://host/api/x-agent/connections/search', expect.objectContaining({ body: JSON.stringify({ search: 'slack' }) }))
    expect(result.isError).toBeUndefined()
    const text = result.content[0].text
    expect(text).toContain('## Slack\n')
    expect(text).toContain('- Account `slack` — Team communication platform. [assigned]\n')
    expect(text).toContain('- Account `slackbot` (Slack Bot) — Workspace search and history with messaging as a Slack bot. Connect: request_connected_account toolkit "slackbot".')
    // Slack's guide is a manifest and a page of steps: a separate read.
    expect(text).toContain('- Integration `slack` (Slack) — the agent\'s own identity. Set up: list_available_integration_providers with provider "slack".')
    expect(text).toContain('Guidance: Talking with people as the agent → the integration.')
    expect(text).not.toContain('[setup required]')
  })

  it('says why an integration cannot be set up here, inlines a one-line guide, and flags MCPs needing their own OAuth app', async () => {
    hostReturns({ total: 300, services: [{
      service: 'zoom', displayName: 'Zoom', category: 'Communication',
      accounts: [],
      mcps: [{ slug: 'zoom', displayName: 'Zoom', description: 'Meetings', url: 'https://mcp.zoom.example/mcp', authType: 'oauth', setupRequired: true, assigned: 'auth_required' }],
      integrations: [
        { provider: 'recall', name: 'Meetings', guide: 'Nothing to set up: joining a meeting with join_meeting creates this integration when the agent has none.' },
        { provider: 'linear', name: 'Linear', unavailable: 'Needs a webhook relay, which this host does not have.' },
      ],
    }] })
    const text = (await search('zoom')).content[0].text

    expect(text).toContain('- MCP Zoom (https://mcp.zoom.example/mcp) [oauth] [setup required] — Meetings. [assigned, needs reconnecting]\n')
    expect(text).toContain('(Meetings) — the agent\'s own identity. Nothing to set up: joining a meeting with join_meeting creates this integration when the agent has none.')
    expect(text).toContain('(Linear) — the agent\'s own identity. Not available: Needs a webhook relay, which this host does not have.')
    // Already assigned, so the user has nothing to register.
    expect(text).not.toContain('rejects dynamic client registration')
  })

  it('answers no term with the host\'s category index', async () => {
    const fetch = hostReturns({ total: 2, index: [{ category: 'Communication', services: 1 }, { category: 'Design', services: 1 }] })
    const text = (await search()).content[0].text

    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ search: '' }) }))
    expect(text).toContain('2 services, by category:\n\n- Communication (1)\n- Design (1)')
  })

  it('points past the partial MCP directory when nothing matches', async () => {
    hostReturns({ total: 300, services: [] })
    expect((await search('nothing')).content[0].text).toContain('No services found matching "nothing"')
  })

  it('reports a host failure as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Unauthorized' }, { status: 401 })))
    expect(await search('slack')).toMatchObject({ isError: true, content: [{ text: 'Failed to search connection options: Unauthorized' }] })
  })
})
