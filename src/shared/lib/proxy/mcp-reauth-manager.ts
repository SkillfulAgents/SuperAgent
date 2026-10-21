import { AttachedStores, type AgentStoreDirectory } from '@shared/lib/agent-actor/store-directory'
import type { McpReauthDetails, McpReauthWaits, ReauthOutcome } from './reauth-waits'
import { awaitReauth } from './reauth-request'

export {
  MCP_REAUTH_TIMEOUT_MS,
  createMcpReauthWaits,
  type McpReauthDetails,
  type McpReauthRequest,
  type McpReauthWaits,
} from './reauth-waits'

/**
 * The router in front of every agent's MCP re-auth waits. The waits live in
 * each agent's actor (`AgentReauthWaits`, see `reauth-waits`); this singleton
 * dispatches the calls that arrive with a slug.
 */
export class McpReauthManager {
  private readonly agents = new AttachedStores<McpReauthWaits>('MCP re-auth waits')

  /** Called once by the agent registry with the way to each agent's waits. */
  attachAgents(directory: AgentStoreDirectory<McpReauthWaits> | null): void {
    this.agents.attach(directory)
  }

  /** Park a request of the agent on its re-auth card and wait for how it ends (see `awaitReauth`). */
  requestReauth(details: McpReauthDetails, signal?: AbortSignal): Promise<ReauthOutcome> {
    const waits = this.agents.get(details.agentSlug)
    return awaitReauth(waits, details, signal)
  }

  /** `AgentReauthWaits.request` on the agent's waits: the outcome as data. */
  request(agentSlug: string, details: Omit<McpReauthDetails, 'agentSlug'>, options: { waitId: string }): Promise<ReauthOutcome> {
    return this.agents.get(agentSlug).request(details, options)
  }

  /** `AgentReauthWaits.withdraw` on the agent's waits. */
  withdraw(agentSlug: string, waitId: string): void {
    this.agents.peek(agentSlug)?.withdraw(waitId)
  }

  /** `AgentReauthWaits.dismiss` on the agent's waits; false when it holds no such card. */
  dismiss(entryId: string, agentSlug: string, reason?: string): boolean {
    return this.agents.peek(agentSlug)?.dismiss(entryId, reason) ?? false
  }

  /** Settle this agent's waiters without resuming them against stale tools. */
  replaceMcp(entryId: string, agentSlug: string, replacementMcpId: string): boolean {
    return this.agents.peek(agentSlug)?.replace(entryId, replacementMcpId) ?? false
  }

  /** Resume the agent's parked proxy requests that use the reconnected MCP. */
  completeMcp(agentSlug: string, mcpId: string): number {
    return this.agents.peek(agentSlug)?.complete(mcpId) ?? 0
  }
}

const globalForMcpReauthManager = globalThis as unknown as {
  mcpReauthManager: McpReauthManager | undefined
}

export const mcpReauthManager =
  globalForMcpReauthManager.mcpReauthManager ?? new McpReauthManager()

if (process.env.NODE_ENV !== 'production') {
  globalForMcpReauthManager.mcpReauthManager = mcpReauthManager
}
