/**
 * Search Connection Options Tool
 *
 * One search for every way to reach a service: a connected account, a remote
 * MCP server, an agent integration. The host groups them by service, marks
 * what this agent already has and adds the service's guidance on which to use,
 * so the full catalog never sits in context.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callHost, textResult, XAgentError } from './agents/host-client'

const assigned = z.string().optional()
const serviceSchema = z.object({
  service: z.string(),
  displayName: z.string(),
  category: z.string(),
  description: z.string().optional(),
  accounts: z.array(z.object({ toolkit: z.string(), displayName: z.string(), description: z.string(), assigned })),
  mcps: z.array(z.object({ slug: z.string(), displayName: z.string(), description: z.string(), url: z.string(), authType: z.string(), setupRequired: z.boolean(), assigned })),
  integrations: z.array(z.object({ provider: z.string(), name: z.string(), guide: z.string().optional(), unavailable: z.string().optional(), oneClickWorkspace: z.string().optional(), assigned })),
  guidance: z.string().optional(),
})
const searchResponseSchema = z.object({
  total: z.number(),
  services: z.array(serviceSchema).optional(),
  index: z.array(z.object({ category: z.string(), services: z.number() })).optional(),
})
type ConnectionService = z.infer<typeof serviceSchema>

const MCP_DIRECTORY_NOTE = 'The MCP directory is partial: a service may have an MCP server it does not list. Search the web for "<service> MCP server" and pass its URL to request_remote_mcp.'

const SETUP_REQUIRED_NOTE = 'An MCP marked [setup required] rejects dynamic client registration: before it can connect, the user has to register an OAuth app in that provider\'s own console, allowlist our callback URL, and supply the resulting client ID. Tell them that up front — the approval prompt walks them through the exact steps and shows the callback URL to copy. If they ask you to fetch the client ID from their console, pass it to request_remote_mcp as clientId; never ask them for a client secret.'

const STATUS_LABELS: Record<string, string> = { auth_required: 'needs reconnecting' }

function assignedMark(status: string | undefined): string {
  if (!status) return ''
  return status === 'active' ? ' [assigned]' : ` [assigned, ${STATUS_LABELS[status] ?? status}]`
}

// A one-line guide (the meeting bot's "nothing to set up") says it all; a
// longer one (Slack's manifest) is a separate read.
function integrationSetup(integration: ConnectionService['integrations'][number]): string {
  if (integration.assigned) return ''
  if (integration.unavailable) return ` Not available: ${integration.unavailable}`
  if (integration.oneClickWorkspace) return ` One click: the ${integration.oneClickWorkspace} team directory creates this app for the user; hand the setup over with request_integration_setup.`
  if (integration.guide && !integration.guide.includes('\n') && integration.guide.length <= 200) return ` ${integration.guide}`
  return ` Set up: list_available_integration_providers with provider "${integration.provider}".`
}

function formatService(service: ConnectionService): string[] {
  const lines = [`## ${service.displayName}${service.description ? ` — ${service.description}` : ''}`]
  for (const account of service.accounts) {
    lines.push(`- Account \`${account.toolkit}\`${account.displayName === service.displayName ? '' : ` (${account.displayName})`} — ${account.description}.${assignedMark(account.assigned)}${account.assigned ? '' : ` Connect: request_connected_account toolkit "${account.toolkit}".`}`)
  }
  for (const mcp of service.mcps) {
    lines.push(`- MCP ${mcp.displayName} (${mcp.url}) [${mcp.authType}]${mcp.setupRequired ? ' [setup required]' : ''} — ${mcp.description}.${assignedMark(mcp.assigned)}${mcp.assigned ? '' : ' Connect: request_remote_mcp with this URL.'}`)
  }
  for (const integration of service.integrations) {
    lines.push(`- Integration \`${integration.provider}\` (${integration.name}) — the agent's own identity.${assignedMark(integration.assigned)}${integrationSetup(integration)}`)
  }
  if (service.guidance) lines.push(`Guidance: ${service.guidance}`)
  return lines
}

export const searchConnectionOptionsTool = tool(
  'search_connection_options',
  `Search every way this host offers to connect a service, grouped by service: a connected account, a remote MCP server, an agent integration. Call it before requesting or setting up any of them, and to answer "can you connect to X?". Provide a term to match on service name, category, or what you need it to do; call with no term for a category index.

Each entry lists the ways this host offers, marks the ones this agent already has [assigned], and says how to start the others:
- Account: the user's own account. You call its API through the proxy, so scripts, dashboards and widgets can use it too. Request it with request_connected_account.
- MCP: the user's own account through the provider's MCP server, whose tools you call directly. Request it with request_remote_mcp.
- Integration: the agent's own identity on the service (a bot, an app, an inbox). People reach the agent through it and it acts under its own name. Set it up with add_agent_integration or hand it to the user with request_integration_setup, as list_available_integration_providers describes.

When an entry has Guidance, follow it. Otherwise: act as the user through an account or an MCP, and as the agent through an integration. When an assigned MCP needs reconnecting and an account for the same service is assigned and active, use the account rather than asking the user to reconnect. A way missing from an entry is not offered here.`,
  {
    search: z
      .string()
      .optional()
      .describe('Search term: a service name, a category, or what you need it to do. Omit to get a category index instead.'),
  },
  async (args) => {
    try {
      const result = await callHost('connections/search', { search: args.search ?? '' }, searchResponseSchema)
      if (result.index) {
        if (result.total === 0) return textResult('No connection options are available on this host.')
        return textResult([
          `${result.total} services, by category:`,
          '',
          ...result.index.map(({ category, services }) => `- ${category} (${services})`),
          '',
          'Search by category name, service name, or what you need it to do to see each service\'s ways in.',
          '',
          MCP_DIRECTORY_NOTE,
        ].join('\n'))
      }
      const services = result.services ?? []
      if (services.length === 0) {
        return textResult(`No services found matching "${args.search}". Call with no term for the category index.\n\n${MCP_DIRECTORY_NOTE}`)
      }
      return textResult([
        `Found ${services.length} service(s):`,
        '',
        ...services.flatMap((service) => [...formatService(service), '']),
        ...(services.some((service) => service.mcps.some((mcp) => mcp.setupRequired && !mcp.assigned)) ? [SETUP_REQUIRED_NOTE, ''] : []),
        MCP_DIRECTORY_NOTE,
      ].join('\n'))
    } catch (error) {
      return textResult(`Failed to search connection options: ${error instanceof XAgentError ? error.message : String(error)}`, true)
    }
  },
)
