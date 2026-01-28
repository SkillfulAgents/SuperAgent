import { createContainerClient } from './client-factory'
import type { ContainerClient, ContainerConfig } from './types'
import { db } from '@shared/lib/db'
import { agentConnectedAccounts, connectedAccounts } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getConnectionToken } from '@shared/lib/composio/client'
import { messagePersister } from './message-persister'

// Singleton to manage all container clients
class ContainerManager {
  private clients: Map<string, ContainerClient> = new Map()

  // Get or create a container client for an agent
  getClient(agentId: string): ContainerClient {
    let client = this.clients.get(agentId)

    if (!client) {
      const config: ContainerConfig = {
        agentId,
      }

      client = createContainerClient(config)
      this.clients.set(agentId, client)
    }

    return client
  }

  // Ensure container is running, starting it with connected accounts if needed
  // Returns the container client
  //
  // Note: User secrets are now stored in .env file in the workspace,
  // not passed as env vars. Only connected account tokens are injected.
  //
  // Parameter is agentId for backwards compatibility, but will be slug after migration
  async ensureRunning(agentId: string): Promise<ContainerClient> {
    const client = this.getClient(agentId)
    const info = await client.getInfo()

    if (info.status !== 'running') {
      // Connected account tokens are still injected as env vars
      // (they're OAuth tokens that may refresh, managed by Composio)
      const envVars: Record<string, string> = {}

      // Fetch connected accounts for this agent
      const accountMappings = await db
        .select({
          account: connectedAccounts,
        })
        .from(agentConnectedAccounts)
        .innerJoin(
          connectedAccounts,
          eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id)
        )
        .where(eq(agentConnectedAccounts.agentSlug, agentId))

      // Group accounts by toolkit and fetch tokens
      const tokensByToolkit: Record<string, Record<string, string>> = {}

      for (const { account } of accountMappings) {
        if (account.status !== 'active') continue

        try {
          const { accessToken } = await getConnectionToken(account.composioConnectionId)

          if (!tokensByToolkit[account.toolkitSlug]) {
            tokensByToolkit[account.toolkitSlug] = {}
          }
          tokensByToolkit[account.toolkitSlug][account.displayName] = accessToken
        } catch (error) {
          console.error(
            `Failed to get token for connected account ${account.displayName}:`,
            error
          )
          // Continue with other accounts
        }
      }

      // Add connected account tokens as env vars
      // Format: CONNECTED_ACCOUNT_GMAIL={"Work Gmail": "token1", "Personal": "token2"}
      for (const [toolkit, tokens] of Object.entries(tokensByToolkit)) {
        const envVarName = `CONNECTED_ACCOUNT_${toolkit.toUpperCase()}`
        envVars[envVarName] = JSON.stringify(tokens)
      }

      // Start container (user secrets are in .env file in workspace)
      await client.start({ envVars })

      // Broadcast agent status change globally
      messagePersister.broadcastGlobal({
        type: 'agent_status_changed',
        agentSlug: agentId,
        status: 'running',
      })
    }

    return client
  }

  // Remove a client from the cache
  removeClient(agentId: string): void {
    this.clients.delete(agentId)
  }

  // Stop all containers
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.clients.entries()).map(
      async ([agentId, client]) => {
        try {
          await client.stop()
        } catch (error) {
          console.error(`Failed to stop container for agent ${agentId}:`, error)
        }
      }
    )
    await Promise.all(stopPromises)
    this.clients.clear()
  }

  // Synchronous stop - used for exit handlers where async isn't available
  stopAllSync(): void {
    for (const [agentId, client] of this.clients.entries()) {
      try {
        client.stopSync()
      } catch (error) {
        console.error(`Failed to stop container for agent ${agentId} (sync):`, error)
      }
    }
    this.clients.clear()
  }

  // Check if any agents have running containers
  async hasRunningAgents(): Promise<boolean> {
    for (const client of this.clients.values()) {
      const info = await client.getInfo()
      if (info.status === 'running') {
        return true
      }
    }
    return false
  }

  // Get list of running agent IDs
  async getRunningAgentIds(): Promise<string[]> {
    const running: string[] = []
    for (const [agentId, client] of this.clients.entries()) {
      const info = await client.getInfo()
      if (info.status === 'running') {
        running.push(agentId)
      }
    }
    return running
  }
}

// Export singleton instance
// Use globalThis to persist across hot reloads in development
const globalForManager = globalThis as unknown as {
  containerManager: ContainerManager | undefined
}

export const containerManager =
  globalForManager.containerManager ?? new ContainerManager()

if (process.env.NODE_ENV !== 'production') {
  globalForManager.containerManager = containerManager
}

// Note: Graceful shutdown handlers are registered in the application entry point
// (src/main/index.ts for Electron, src/web/server.ts for web)
// This avoids side effects at module import time and allows proper cleanup coordination
