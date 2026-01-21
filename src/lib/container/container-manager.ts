import { createContainerClient } from './client-factory'
import type { ContainerClient, ContainerConfig } from './types'
import { db } from '@/lib/db'
import { agentSecrets, agentConnectedAccounts, connectedAccounts } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getConnectionToken } from '@/lib/composio/client'

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

  // Ensure container is running, starting it with secrets and connected accounts if needed
  // Returns the container client
  async ensureRunning(agentId: string): Promise<ContainerClient> {
    const client = this.getClient(agentId)
    const info = await client.getInfo()

    if (info.status !== 'running') {
      // Fetch secrets for this agent
      const secrets = await db
        .select()
        .from(agentSecrets)
        .where(eq(agentSecrets.agentId, agentId))

      // Convert secrets to env vars
      const envVars: Record<string, string> = {}
      for (const secret of secrets) {
        envVars[secret.envVar] = secret.value
      }

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
        .where(eq(agentConnectedAccounts.agentId, agentId))

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

      // Start with secrets and connected accounts as env vars
      await client.start({ envVars })
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
// Use globalThis to persist across Next.js hot reloads in development
const globalForManager = globalThis as unknown as {
  containerManager: ContainerManager | undefined
}

export const containerManager =
  globalForManager.containerManager ?? new ContainerManager()

if (process.env.NODE_ENV !== 'production') {
  globalForManager.containerManager = containerManager
}

// Graceful shutdown handling
let isShuttingDown = false

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`\nReceived ${signal}, stopping all containers...`)
  try {
    await containerManager.stopAll()
    console.log('All containers stopped.')
  } catch (error) {
    console.error('Error stopping containers:', error)
  }
  process.exit(0)
}

// Synchronous shutdown for 'exit' event where async isn't available
function syncShutdown() {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log('\nProcess exiting, stopping all containers (sync)...')
  containerManager.stopAllSync()
  console.log('All containers stopped.')
}

// Only register handlers in runtime (not during build)
if (process.env.NODE_ENV !== 'production' || process.env.NEXT_PHASE !== 'phase-production-build') {
  // Async handlers for graceful shutdown (works for Ctrl+C in dev)
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'))

  // Handle uncaught exceptions
  process.on('uncaughtException', async (error) => {
    console.error('Uncaught exception:', error)
    await gracefulShutdown('uncaughtException')
  })

  // Handle unhandled promise rejections
  process.on('unhandledRejection', async (reason) => {
    console.error('Unhandled rejection:', reason)
    await gracefulShutdown('unhandledRejection')
  })

  // Only add exit/beforeExit handlers in production (HMR triggers these in dev)
  if (process.env.NODE_ENV === 'production') {
    process.on('exit', syncShutdown)
    process.on('beforeExit', () => {
      if (!isShuttingDown) {
        console.log('\nEvent loop drained, stopping all containers...')
        containerManager.stopAllSync()
      }
    })
  }
}
