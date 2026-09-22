import { AttachedStores, type AgentStoreDirectory } from '@shared/lib/agent-actor/store-directory'
import type { McpReauthDetails, McpReauthWaits } from './reauth-waits'

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
 * dispatches the calls that arrive with a slug and runs the ones that span
 * agents — completing an MCP resumes every agent's requests parked on it,
 * and shutdown rejects them all.
 */
export class McpReauthManager {
  private readonly agents = new AttachedStores<McpReauthWaits>('MCP re-auth waits')

  /** Called once by the agent registry with the way to each agent's waits. */
  attachAgents(directory: AgentStoreDirectory<McpReauthWaits> | null): void {
    this.agents.attach(directory)
  }

  requestReauth(details: McpReauthDetails, signal?: AbortSignal): Promise<void> {
    return this.agents.get(details.agentSlug).request(details, signal)
  }

  /** `AgentReauthWaits.dismiss` on the agent's waits; false when it holds no such card. */
  dismiss(entryId: string, agentSlug: string, reason?: string): boolean {
    return this.agents.peek(agentSlug)?.dismiss(entryId, reason) ?? false
  }

  /** Settle this agent's waiters without resuming them against stale tools. */
  replaceMcp(entryId: string, agentSlug: string, replacementMcpId: string): boolean {
    return this.agents.peek(agentSlug)?.replace(entryId, replacementMcpId) ?? false
  }

  /** Resume every parked proxy request, of every agent, that uses the reconnected MCP. */
  completeMcp(mcpId: string): number {
    let completed = 0
    for (const waits of this.agents.all()) completed += waits.complete(mcpId)
    return completed
  }

  rejectAll(): void {
    for (const waits of this.agents.all()) waits.rejectAll()
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
