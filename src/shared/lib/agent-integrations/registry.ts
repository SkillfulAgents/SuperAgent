import type { IntegrationProviderSetup } from './setup-types'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { PublicAgentIntegration } from './public'
import type { IntegrationMcpConnection } from './mcp-types'
import type { AgentIntegration } from './agent-integration'
import type { AgentIntegrationDefinition, AgentIntegrationRecord, IntegrationRoute, IntegrationSessionContext, IntegrationSessionPolicy } from './types'
import { taskManagerProviders } from '../task-manager-integrations/providers'
import { chatProviders } from '../chat-integrations/providers'

export interface IntegrationProvider {
  setup?: IntegrationProviderSetup
  definition: AgentIntegrationDefinition
  /** Child tables, in deletion order, owned by this provider/family. */
  storage?(): readonly SQLiteTable[]
  serialize?(record: AgentIntegrationRecord): PublicAgentIntegration
  updateSettings?(record: AgentIntegrationRecord, input: Record<string, unknown>): Promise<void>
  configuration?: {
    identityLabel?: string
    identityPaths: readonly string[]
    uniqueKey(input: unknown): string | null
    merge(stored: string, patch: Record<string, unknown>): Record<string, unknown>
  }
  /** Access and session policy must be available independently of a live connection. */
  policy: Pick<AgentIntegration, 'isAllowed' | 'sessionPolicy'>
  create(record: AgentIntegrationRecord): Promise<AgentIntegration>
  mcp?(record: AgentIntegrationRecord): Promise<IntegrationMcpConnection | null>
  cleanup?(record: AgentIntegrationRecord): Promise<void>
  describeTarget?(externalId: string): Promise<{ type?: string }>
}

/** The composition root is the only application module that enumerates families. */
export class AgentIntegrationRegistry {
  private providers = new Map<string, IntegrationProvider>()

  constructor(providers: readonly IntegrationProvider[] = []) {
    for (const provider of providers) this.register(provider)
  }

  register(provider: IntegrationProvider): void {
    if (this.providers.has(provider.definition.provider)) throw new Error(`Duplicate integration provider: ${provider.definition.provider}`)
    this.providers.set(provider.definition.provider, provider)
  }

  storageTables(): SQLiteTable[] { return [...new Set([...this.providers.values()].flatMap(provider => provider.storage?.() ?? []))] }

  getProvider(provider: string): IntegrationProvider {
    const implementation = this.providers.get(provider)
    if (!implementation) throw new Error(`Unknown integration provider: ${provider}`)
    return implementation
  }

  getDefinition(provider: string): AgentIntegrationDefinition | undefined {
    return this.providers.get(provider)?.definition
  }

  listDefinitions(): AgentIntegrationDefinition[] {
    return [...this.providers.values()].map(provider => provider.definition)
  }

  async isAllowed(context: IntegrationSessionContext): Promise<boolean> {
    return (await this.providers.get(context.integration.provider)?.policy.isAllowed(context)) ?? false
  }

  sessionPolicy(record: AgentIntegrationRecord, route: Partial<IntegrationRoute>): IntegrationSessionPolicy {
    const provider = this.providers.get(record.provider)
    if (!provider) throw new Error(`Unknown integration provider: ${record.provider}`)
    return provider.policy.sessionPolicy(record, route)
  }

  async describeTarget(provider: string, externalId: string): Promise<{ type?: string }> {
    return this.providers.get(provider)?.describeTarget?.(externalId) ?? {}
  }

  async cleanup(record: AgentIntegrationRecord): Promise<void> {
    await this.providers.get(record.provider)?.cleanup?.(record)
  }

  async getMcpConnection(record: AgentIntegrationRecord): Promise<IntegrationMcpConnection | null> {
    return this.providers.get(record.provider)?.mcp?.(record) ?? null
  }

  async create(record: AgentIntegrationRecord): Promise<AgentIntegration> {
    const provider = this.providers.get(record.provider)
    if (!provider) throw new Error(`Unknown integration provider: ${record.provider}`)
    return provider.create(record)
  }
}

export const agentIntegrationRegistry = new AgentIntegrationRegistry([...chatProviders, ...taskManagerProviders])
