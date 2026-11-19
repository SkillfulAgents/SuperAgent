import { describe, expect, it } from 'vitest'
import { SUPPORTED_PROVIDERS, getAgentOfferedProviders } from '../account-providers/service-catalog'
import { COMMON_MCP_SERVERS } from '../mcp/common-servers'
import { agentIntegrationRegistry } from '../agent-integrations/registry'
import { buildConnectionCatalog, searchConnectionCatalog } from './catalog'
import { SERVICE_DEFINITIONS } from './service-definitions'

// The real catalogs as a platform-mode host offers them, every integration set up-able.
function realCatalog() {
  return buildConnectionCatalog({
    accounts: getAgentOfferedProviders('composio', true).map((provider) => ({
      toolkit: provider.slug, displayName: provider.displayName, description: provider.description, category: provider.category,
    })),
    mcps: COMMON_MCP_SERVERS.map((server) => ({
      slug: server.slug, displayName: server.displayName, description: server.description, category: server.category,
      url: server.url, authType: server.authType, setupRequired: !!server.setup?.requiresClientId,
    })),
    integrations: agentIntegrationRegistry.listDefinitions().map(({ provider, name, family }) => ({ provider, name, family, guide: 'Steps.' })),
  })
}

describe('service definitions', () => {
  it('name only members the catalogs have', () => {
    const accounts = new Set(SUPPORTED_PROVIDERS.map((provider) => provider.slug))
    const mcps = new Set(COMMON_MCP_SERVERS.map((server) => server.slug))
    const integrations = new Set(agentIntegrationRegistry.listDefinitions().map((definition) => definition.provider))
    const unknown = SERVICE_DEFINITIONS.flatMap((definition) => [
      ...(definition.accounts ?? []).filter((slug) => !accounts.has(slug)).map((slug) => `${definition.service}: account ${slug}`),
      ...(definition.mcps ?? []).filter((slug) => !mcps.has(slug)).map((slug) => `${definition.service}: mcp ${slug}`),
      ...(definition.integrations ?? []).filter((slug) => !integrations.has(slug)).map((slug) => `${definition.service}: integration ${slug}`),
    ])
    expect(unknown).toEqual([])
  })

  it('each earn their place: guidance, or members that would not group themselves', () => {
    const idle = SERVICE_DEFINITIONS.filter((definition) => {
      if (definition.guidance) return false
      const slugs = [...definition.accounts ?? [], ...definition.mcps ?? [], ...definition.integrations ?? []]
      return slugs.every((slug) => slug === definition.service)
    }).map((definition) => definition.service)
    expect(idle).toEqual([])
  })

  it('have unique service keys that no ungrouped slug collides with', () => {
    const keys = realCatalog().map((service) => service.service)
    expect(keys.length).toBe(new Set(keys).size)
  })
})

describe('the real catalog', () => {
  const services = realCatalog()
  const find = (service: string) => services.find((candidate) => candidate.service === service)

  it('shows Slack\'s accounts and its bot integration together, with guidance', () => {
    expect(find('slack')).toMatchObject({
      accounts: [{ toolkit: 'slack' }, { toolkit: 'slackbot' }],
      mcps: [],
      integrations: [{ provider: 'slack' }],
      guidance: expect.stringContaining('integration'),
    })
    expect(find('slackbot')).toBeUndefined()
  })

  it('offers Linear and GitHub all three ways', () => {
    for (const service of ['linear', 'github']) {
      const entry = find(service)!
      expect([entry.accounts.length, entry.mcps.length, entry.integrations.length]).toEqual([1, 1, 1])
    }
  })

  it('prefers the Figma and Notion MCPs', () => {
    for (const service of ['figma', 'notion']) {
      expect(find(service)).toMatchObject({ accounts: [{ toolkit: service }], mcps: [{ slug: service }], guidance: expect.stringMatching(/^Prefer the MCP/) })
    }
  })

  it('puts the meeting bot with each calling service, and the agent inbox with each mailbox', () => {
    for (const service of ['zoom', 'googlemeet', 'microsoft_teams', 'meetings']) {
      expect(find(service)?.integrations.map(({ provider }) => provider)).toEqual(['recall'])
    }
    for (const service of ['gmail', 'outlook', 'email']) {
      expect(find(service)?.integrations.map(({ provider }) => provider)).toEqual(['platform-email'])
    }
  })

  it('groups services whose slugs differ between catalogs', () => {
    expect(find('atlassian')).toMatchObject({ accounts: [{ toolkit: 'jira' }, { toolkit: 'confluence' }], mcps: [{ slug: 'atlassian' }] })
    expect(find('cal')?.mcps.map(({ slug }) => slug)).toEqual(['cal-com'])
    expect(find('hugging_face')?.mcps.map(({ slug }) => slug)).toEqual(['huggingface'])
  })

  it.each([
    ['Facebook Pages', 'facebook'],
    ['WhatsApp Business', 'whatsapp'],
    ['NotebookLM Enterprise', 'notebook_lm'],
    ['Cal.com', 'cal'],
    ['Hugging Face', 'hugging_face'],
  ])('finds %s by its public name first', (name, service) => {
    expect(searchConnectionCatalog(services, name)[0]?.service).toBe(service)
  })

  it('finds services by category and by use case', () => {
    expect(searchConnectionCatalog(services, 'Analytics & Data').map(({ service }) => service)).toContain('google_analytics')
    expect(searchConnectionCatalog(services, 'transcripts').map(({ service }) => service)).toContain('fathom')
  })
})
