import type { AgentIntegration } from './agent-integration'
import type { AgentIntegrationDefinition, AgentIntegrationRecord } from './types'
import { chatProviders } from '../chat-integrations/providers'

export interface IntegrationProvider {
  definition: AgentIntegrationDefinition
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
