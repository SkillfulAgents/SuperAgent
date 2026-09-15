import type { AgentIntegration } from './agent-integration'
import type { AgentIntegrationDefinition, AgentIntegrationRecord, IntegrationRoute, IntegrationSessionContext, IntegrationSessionPolicy } from './types'
import { chatProviders } from '../chat-integrations/providers'

export interface IntegrationProvider {
  definition: AgentIntegrationDefinition
  /** Access and session policy must be available independently of a live connection. */
  policy: Pick<AgentIntegration, 'isAllowed' | 'sessionPolicy'>
  create(record: AgentIntegrationRecord): Promise<AgentIntegration>
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

  getDefinition(provider: string): AgentIntegrationDefinition | undefined {
    return this.providers.get(provider)?.definition
  }

  listDefinitions(): AgentIntegrationDefinition[] {
    return [...this.providers.values()].map(provider => provider.definition)
  }

  isAllowed(context: IntegrationSessionContext): boolean {
    return this.providers.get(context.integration.provider)?.policy.isAllowed(context) ?? false
  }

  sessionPolicy(record: AgentIntegrationRecord, route: Partial<IntegrationRoute>): IntegrationSessionPolicy {
    const provider = this.providers.get(record.provider)
    if (!provider) throw new Error(`Unknown integration provider: ${record.provider}`)
    return provider.policy.sessionPolicy(record, route)
  }

  async describeTarget(provider: string, externalId: string): Promise<{ type?: string }> {
    return this.providers.get(provider)?.describeTarget?.(externalId) ?? {}
  }

  async create(record: AgentIntegrationRecord): Promise<AgentIntegration> {
    const provider = this.providers.get(record.provider)
    if (!provider) throw new Error(`Unknown integration provider: ${record.provider}`)
    return provider.create(record)
  }
}

export const agentIntegrationRegistry = new AgentIntegrationRegistry(chatProviders)
