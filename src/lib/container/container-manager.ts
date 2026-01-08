import { LocalDockerContainerClient } from './local-docker-client'
import type { ContainerClient, ContainerConfig } from './types'
import { db } from '@/lib/db'
import { agentSecrets } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

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

      client = new LocalDockerContainerClient(config)
      this.clients.set(agentId, client)
    }

    return client
  }

  // Ensure container is running, starting it with secrets if needed
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

      // Convert to env vars
      const envVars: Record<string, string> = {}
      for (const secret of secrets) {
        envVars[secret.envVar] = secret.value
      }

      // Start with secrets as env vars
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
