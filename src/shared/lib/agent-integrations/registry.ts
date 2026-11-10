import { captureException } from '../error-reporting'
import { platformEmailProvider } from '../email-integrations/provider'
import type { IntegrationProviderSetup } from './setup-types'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { PublicAgentIntegration } from './public'
import type { IntegrationMcpConnection } from './mcp-types'
import type { AgentIntegration } from './agent-integration'
import type { AgentIntegrationDefinition, AgentIntegrationRecord, IntegrationRoute, IntegrationSessionContext, IntegrationSessionPolicy } from './types'
import type { LiveConversationSetting } from '../voice/live-types'
import { taskManagerProviders } from '../task-manager-integrations/providers'
import { meetingProviders } from '../meeting-integrations/providers'
import { chatProviders } from '../chat-integrations/providers'
import { formatProviderName } from './presentation'

export interface IntegrationProvider {
  /** Delegate to the integration class without constructing a live connection. */
  isAvailable?(): boolean | Promise<boolean>
  setup?: IntegrationProviderSetup
  definition: AgentIntegrationDefinition
  /** Child tables, in deletion order, owned by this provider/family. */
  storage?(): readonly SQLiteTable[]
  serialize?(record: AgentIntegrationRecord): PublicAgentIntegration
  /** Resolves `{ reconnect: true }` when the change needs a fresh connection (e.g. a new transport). */
  updateSettings?(record: AgentIntegrationRecord, input: Record<string, unknown>): Promise<void | { reconnect?: boolean }>
  configuration?: {
    identityLabel?: string
    identityPaths: readonly string[]
    uniqueKey(input: unknown): string | null
    merge(stored: string, patch: Record<string, unknown>): Record<string, unknown>
  }
  /** Access and session policy must be available independently of a live connection. */
  policy: Pick<AgentIntegration, 'isAllowed' | 'sessionPolicy'>
  /**
   * How a voice conversation in one of this provider's sessions differs from
   * a person alone with the app (a meeting room). Absent for providers whose
   * sessions are ordinary conversations.
   */
  liveSetting?(record: AgentIntegrationRecord, externalId: string): Promise<LiveConversationSetting | undefined>
  create(record: AgentIntegrationRecord): Promise<AgentIntegration>
  mcp?(record: AgentIntegrationRecord): Promise<IntegrationMcpConnection | null>
  cleanup?(record: AgentIntegrationRecord): Promise<void>
  describeTarget?(externalId: string): Promise<{ type?: string }>
  /** The conversation a session's target belongs to, with its name: itself, or the channel a thread is in. */
  conversationOf?(externalId: string, displayName: string | null): Promise<{ externalId: string; displayName: string | null }>
  /** Safe identity the agent may quote. Credentials stay out. */
  agentDiscovery?(record: AgentIntegrationRecord): { address?: string }
}

/** A conversation the agent can post to; a channel lists its threads when asked for them. */
export interface IntegrationConversation {
  externalId: string
  displayName: string | null
  type?: string
  threads?: Array<{ externalId: string; displayName: string | null; type?: string }>
}

/** Threads listed under a channel: past this, only the newest stay. */
export const THREADS_PER_CHANNEL = 20

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

  async isAvailable(provider: string): Promise<boolean> {
    const implementation = this.providers.get(provider)
    if (!implementation) return false
    try { return await implementation.isAvailable?.() ?? true }
    catch (error) {
      captureException(error, { tags: { component: 'agent-integration', operation: 'availability' }, extra: { provider } })
      return false
    }
  }

  async listAvailableDefinitions(): Promise<AgentIntegrationDefinition[]> {
    const definitions = this.listDefinitions()
    const available = await Promise.all(definitions.map(definition => this.isAvailable(definition.provider)))
    return definitions.filter((_, index) => available[index])
  }

  async liveSetting(record: AgentIntegrationRecord, externalId: string): Promise<LiveConversationSetting | undefined> {
    return this.providers.get(record.provider)?.liveSetting?.(record, externalId)
  }

  async isAllowed(context: IntegrationSessionContext): Promise<boolean> {
    return (await this.providers.get(context.integration.provider)?.policy.isAllowed(context)) ?? false
  }

  sessionPolicy(record: AgentIntegrationRecord, route: Partial<IntegrationRoute>): IntegrationSessionPolicy {
    const provider = this.providers.get(record.provider)
    if (!provider) throw new Error(`Unknown integration provider: ${record.provider}`)
    return provider.policy.sessionPolicy(record, route)
  }

  /** The installation's name as the integration UI shows it, else the provider's. */
  displayName(record: AgentIntegrationRecord): string {
    const provider = this.providers.get(record.provider)
    let name: string | null | undefined
    try { name = provider?.serialize?.(record).name } catch { /* invalid stored config: fall through */ }
    return name?.trim() || record.name?.trim() || provider?.definition.name || formatProviderName(record.provider)
  }

  async describeTarget(provider: string, externalId: string): Promise<{ type?: string }> {
    return this.providers.get(provider)?.describeTarget?.(externalId) ?? {}
  }

  /**
   * The conversations behind these sessions, once each: a thread folds into the channel it is in.
   * With `threads`, a channel also lists its threads, newest first, at most THREADS_PER_CHANNEL.
   */
  async conversations(record: AgentIntegrationRecord, sessions: ReadonlyArray<{ externalChatId: string; displayName: string | null; updatedAt: Date; createdAt: Date }>, options: { threads?: boolean } = {}): Promise<IntegrationConversation[]> {
    const byId = new Map<string, IntegrationConversation & { threads: NonNullable<IntegrationConversation['threads']> }>()
    for (const session of [...sessions].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())) {
      const { externalId, displayName } = await this.providers.get(record.provider)?.conversationOf?.(session.externalChatId, session.displayName)
        ?? { externalId: session.externalChatId, displayName: session.displayName }
      const isThread = externalId !== session.externalChatId
      const known = byId.get(externalId) ?? { externalId, displayName: null, threads: [], ...await this.describeTarget(record.provider, externalId) }
      // The channel's own session names it best; a thread's name stands in until one exists.
      known.displayName = (isThread ? null : displayName) ?? known.displayName ?? displayName
      if (options.threads && isThread && known.threads.length < THREADS_PER_CHANNEL) {
        known.threads.push({ externalId: session.externalChatId, displayName: session.displayName, ...await this.describeTarget(record.provider, session.externalChatId) })
      }
      byId.set(externalId, known)
    }
    return [...byId.values()].map(({ threads, ...conversation }) => (threads.length ? { ...conversation, threads } : conversation))
  }

  agentDiscovery(record: AgentIntegrationRecord): { address?: string } {
    return this.providers.get(record.provider)?.agentDiscovery?.(record) ?? {}
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

export const agentIntegrationRegistry = new AgentIntegrationRegistry([...chatProviders, ...taskManagerProviders, ...meetingProviders, platformEmailProvider])
