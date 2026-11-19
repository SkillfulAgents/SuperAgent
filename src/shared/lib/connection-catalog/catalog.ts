/**
 * The agent's connection catalog: one entry per service, with every way this
 * host offers to reach it (a connected account, a remote MCP server, an agent
 * integration) and the service's guidance on which to use.
 *
 * Pure: the caller hands in what this host offers and what the agent already
 * has (`agent-catalog.ts`), so grouping and search are testable on fixtures.
 */
import { SERVICE_DEFINITIONS, type ServiceDefinition } from './service-definitions'

export interface CatalogAccount {
  toolkit: string
  displayName: string
  description: string
  category: string
  /** Set when an account of this toolkit is assigned: `active`, or the status of the one closest to it. */
  assigned?: string
}

export interface CatalogMcp {
  slug: string
  displayName: string
  description: string
  category: string
  url: string
  authType: 'none' | 'oauth' | 'bearer'
  /** The user must register an OAuth app in the provider's console before it connects. */
  setupRequired: boolean
  assigned?: string
}

export interface CatalogIntegration {
  provider: string
  name: string
  family: string
  guide?: string
  unavailable?: string
  oneClickWorkspace?: string
  assigned?: string
}

export interface ConnectionService {
  service: string
  displayName: string
  category: string
  description?: string
  accounts: CatalogAccount[]
  mcps: CatalogMcp[]
  integrations: CatalogIntegration[]
  guidance?: string
}

export interface CatalogSources {
  accounts: readonly CatalogAccount[]
  mcps: readonly CatalogMcp[]
  integrations: readonly CatalogIntegration[]
}

const FAMILY_CATEGORY: Record<string, string> = {
  chat: 'Communication',
  email: 'Communication',
  meeting: 'Communication',
  'task-manager': 'Project Management',
}

/**
 * Groups every account, MCP and integration into services. A member listed by
 * a definition appears in exactly the definitions that list it; the rest join
 * whatever shares their slug. A definition whose members are all missing on
 * this host (a platform-only account, say) is left out.
 */
export function buildConnectionCatalog(
  sources: CatalogSources,
  definitions: readonly ServiceDefinition[] = SERVICE_DEFINITIONS,
): ConnectionService[] {
  const accounts = new Map(sources.accounts.map((account) => [account.toolkit, account]))
  const mcps = new Map(sources.mcps.map((mcp) => [mcp.slug, mcp]))
  const integrations = new Map(sources.integrations.map((integration) => [integration.provider, integration]))

  const claimed = {
    accounts: new Set(definitions.flatMap((definition) => definition.accounts ?? [])),
    mcps: new Set(definitions.flatMap((definition) => definition.mcps ?? [])),
    integrations: new Set(definitions.flatMap((definition) => definition.integrations ?? [])),
  }
  const pick = <T>(slugs: readonly string[] | undefined, from: Map<string, T>) =>
    (slugs ?? []).flatMap((slug) => from.get(slug) ?? [])

  const services: ConnectionService[] = []
  for (const definition of definitions) {
    const members = {
      accounts: pick(definition.accounts, accounts),
      mcps: pick(definition.mcps, mcps),
      integrations: pick(definition.integrations, integrations),
    }
    if (members.accounts.length + members.mcps.length + members.integrations.length === 0) continue
    services.push({
      service: definition.service,
      displayName: definition.displayName,
      category: primaryCategory(members),
      ...(definition.description ? { description: definition.description } : {}),
      ...members,
      ...(definition.guidance ? { guidance: definition.guidance } : {}),
    })
  }

  // The rest group by slug, in catalog order: accounts, then MCPs, then integrations.
  const bySlug = new Map<string, Pick<ConnectionService, 'accounts' | 'mcps' | 'integrations'>>()
  const slot = (slug: string) => {
    let members = bySlug.get(slug)
    if (!members) bySlug.set(slug, members = { accounts: [], mcps: [], integrations: [] })
    return members
  }
  for (const account of sources.accounts) if (!claimed.accounts.has(account.toolkit)) slot(account.toolkit).accounts.push(account)
  for (const mcp of sources.mcps) if (!claimed.mcps.has(mcp.slug)) slot(mcp.slug).mcps.push(mcp)
  for (const integration of sources.integrations) if (!claimed.integrations.has(integration.provider)) slot(integration.provider).integrations.push(integration)
  for (const [slug, members] of bySlug) {
    services.push({
      service: slug,
      displayName: members.accounts[0]?.displayName ?? members.mcps[0]?.displayName ?? members.integrations[0].name,
      category: primaryCategory(members),
      ...members,
    })
  }
  return services
}

function primaryCategory(members: Pick<ConnectionService, 'accounts' | 'mcps' | 'integrations'>): string {
  return members.accounts[0]?.category
    ?? members.mcps[0]?.category
    ?? FAMILY_CATEGORY[members.integrations[0]?.family ?? '']
    ?? 'Other'
}

function searchableText(service: ConnectionService): string[] {
  return [
    service.service, service.displayName, service.category, service.description ?? '',
    ...service.accounts.flatMap((account) => [account.toolkit, account.displayName, account.description, account.category]),
    ...service.mcps.flatMap((mcp) => [mcp.slug, mcp.displayName, mcp.description, mcp.category]),
    ...service.integrations.flatMap((integration) => [integration.provider, integration.name]),
  ].map((text) => text.toLowerCase())
}

/**
 * Services matching the term anywhere in their own or their members' names,
 * slugs, descriptions or categories. A service named by the term comes first,
 * then those whose name contains it, then the rest in catalog order.
 */
export function searchConnectionCatalog(services: readonly ConnectionService[], search: string): ConnectionService[] {
  const term = search.trim().toLowerCase()
  const rank = (service: ConnectionService) => {
    const names = [service.service, service.displayName.toLowerCase()]
    if (names.includes(term)) return 0
    if (names.some((name) => name.includes(term))) return 1
    return 2
  }
  return services
    .filter((service) => searchableText(service).some((text) => text.includes(term)))
    .map((service, index) => ({ service, index, rank: rank(service) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ service }) => service)
}

/** Service counts per primary category, in first-seen order: the answer to a search with no term. */
export function connectionCategoryIndex(services: readonly ConnectionService[]): Array<{ category: string; services: number }> {
  const counts = new Map<string, number>()
  for (const service of services) counts.set(service.category, (counts.get(service.category) ?? 0) + 1)
  return [...counts].map(([category, count]) => ({ category, services: count }))
}
