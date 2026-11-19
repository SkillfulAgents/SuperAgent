import { describe, expect, it } from 'vitest'
import { buildConnectionCatalog, connectionCategoryIndex, searchConnectionCatalog, type CatalogAccount, type CatalogIntegration, type CatalogMcp } from './catalog'
import type { ServiceDefinition } from './service-definitions'

const account = (toolkit: string, extra: Partial<CatalogAccount> = {}): CatalogAccount => ({
  toolkit, displayName: toolkit.toUpperCase(), description: `${toolkit} account`, category: 'Accounts', ...extra,
})
const mcp = (slug: string, extra: Partial<CatalogMcp> = {}): CatalogMcp => ({
  slug, displayName: `${slug} MCP`, description: `${slug} server`, category: 'Servers', url: `https://mcp.${slug}.example/mcp`, authType: 'oauth', setupRequired: false, ...extra,
})
const integration = (provider: string, extra: Partial<CatalogIntegration> = {}): CatalogIntegration => ({
  provider, name: `${provider} bot`, family: 'chat', guide: 'Steps.', ...extra,
})

describe('buildConnectionCatalog', () => {
  it('puts an account, an MCP and an integration with one slug in one service', () => {
    const services = buildConnectionCatalog({ accounts: [account('acme')], mcps: [mcp('acme')], integrations: [integration('acme')] }, [])
    expect(services).toEqual([{
      service: 'acme', displayName: 'ACME', category: 'Accounts',
      accounts: [account('acme')], mcps: [mcp('acme')], integrations: [integration('acme')],
    }])
  })

  it('groups a definition\'s members exactly, with its guidance, and keeps them out of their own slugs', () => {
    const definitions: ServiceDefinition[] = [
      { service: 'chat', displayName: 'Chat', accounts: ['chat', 'chatbot'], integrations: ['chat'], guidance: 'Prefer the integration.' },
    ]
    const services = buildConnectionCatalog({ accounts: [account('chat'), account('chatbot'), account('other')], mcps: [], integrations: [integration('chat')] }, definitions)
    expect(services.map(({ service }) => service)).toEqual(['chat', 'other'])
    expect(services[0]).toMatchObject({
      displayName: 'Chat',
      accounts: [{ toolkit: 'chat' }, { toolkit: 'chatbot' }],
      integrations: [{ provider: 'chat' }],
      guidance: 'Prefer the integration.',
    })
  })

  it('lets one integration serve several services, and leaves it nowhere else', () => {
    const definitions: ServiceDefinition[] = [
      { service: 'zoom', displayName: 'Zoom', accounts: ['zoom'], integrations: ['bot'] },
      { service: 'meet', displayName: 'Meet', accounts: ['meet'], integrations: ['bot'] },
    ]
    const services = buildConnectionCatalog({ accounts: [account('zoom'), account('meet')], mcps: [], integrations: [integration('bot', { family: 'meeting' })] }, definitions)
    expect(services.map(({ service, integrations }) => [service, integrations.map(({ provider }) => provider)])).toEqual([['zoom', ['bot']], ['meet', ['bot']]])
  })

  it('leaves out a definition none of whose members this host offers, and drops missing members from the rest', () => {
    const definitions: ServiceDefinition[] = [
      { service: 'platform-only', displayName: 'Platform only', accounts: ['platform-only'] },
      { service: 'acme', displayName: 'Acme', accounts: ['acme', 'acme-platform'], mcps: ['acme'] },
    ]
    const services = buildConnectionCatalog({ accounts: [account('acme')], mcps: [mcp('acme')], integrations: [] }, definitions)
    expect(services.map(({ service }) => service)).toEqual(['acme'])
    expect(services[0].accounts.map(({ toolkit }) => toolkit)).toEqual(['acme'])
  })

  it('takes a service\'s category from its account, then its MCP, then its integration\'s family', () => {
    const services = buildConnectionCatalog({ accounts: [], mcps: [mcp('server-only')], integrations: [integration('bot-only'), integration('odd', { family: 'unknown' })] }, [])
    expect(services.map(({ service, category, displayName }) => [service, category, displayName])).toEqual([
      ['server-only', 'Servers', 'server-only MCP'],
      ['bot-only', 'Communication', 'bot-only bot'],
      ['odd', 'Other', 'odd bot'],
    ])
  })
})

describe('searchConnectionCatalog', () => {
  const services = buildConnectionCatalog({
    accounts: [account('notes', { description: 'Meeting transcripts' }), account('slack-tools', { displayName: 'Slack Tools' }), account('slack', { displayName: 'Slack' })],
    mcps: [mcp('pixels', { category: 'Design' })],
    integrations: [integration('pager', { name: 'Pager' })],
  }, [])

  it('ranks the service the term names first, then names containing it', () => {
    expect(searchConnectionCatalog(services, 'Slack').map(({ service }) => service)).toEqual(['slack', 'slack-tools'])
  })

  it('matches members\' descriptions, categories and integration names', () => {
    expect(searchConnectionCatalog(services, 'transcripts').map(({ service }) => service)).toEqual(['notes'])
    expect(searchConnectionCatalog(services, 'design').map(({ service }) => service)).toEqual(['pixels'])
    expect(searchConnectionCatalog(services, 'pager').map(({ service }) => service)).toEqual(['pager'])
  })

  it('counts services per primary category for the no-term index', () => {
    expect(connectionCategoryIndex(services)).toEqual([
      { category: 'Accounts', services: 3 },
      { category: 'Design', services: 1 },
      { category: 'Communication', services: 1 },
    ])
  })
})
